#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callOperation, callRaw } from "./client.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { extraTools } from "./extraTools.js";
import { loadOpenApi } from "./openapi.js";
import {
  availableGroups,
  filterToolsByGroup,
  normalizeGroup,
  operationsToTools,
  type ToolDefinition,
} from "./tools.js";

const SERVER_NAME = "wafeq-mcp";
const FALLBACK_VERSION = "unknown";

/**
 * The version this server reports over MCP and on /health. It is read from
 * package.json, which always carries the last released version: the release
 * workflow stamps it from the git tag and writes it back to main, so the number
 * is never maintained by hand and never a placeholder. FALLBACK_VERSION shows up
 * only if package.json cannot be read at all.
 */
function readPackageVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };
    return pkg.version ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

const SERVER_VERSION = readPackageVersion();

/**
 * Sent to the client on initialize. It tells a host how to read the safety
 * banners and states the handful of Wafeq conventions that a model otherwise has
 * to discover by getting a call wrong first.
 */
const SERVER_INSTRUCTIONS = [
  "MCP server for the Wafeq accounting API (https://api.wafeq.com/v1).",
  "",
  "Every tool description opens with a category banner:",
  "  \u{1F7E2} READ-ONLY \u2014 fetches data only; safe to call.",
  "  \u{1F7E1} WRITE \u2014 creates or updates accounting data.",
  "  \u{1F7E0} STATE CHANGE \u2014 moves a document in or out of the ledger; reversible.",
  "  \u{1F534} IRREVERSIBLE \u2014 files with a tax authority or posts a remaining balance;",
  "     there is no API undo. Confirm with the user first.",
  "  \u{1F534} DESTRUCTIVE \u2014 deletes data. Confirm with the user first.",
  "",
  "Conventions: dates are 'YYYY-MM-DD'. Amounts use a dot as the decimal separator.",
  "List endpoints page with `limit` and `offset`. Reports take report-specific date",
  "parameters \u2014 profit-and-loss and cash-flow ranges must cover whole months or",
  "years. PDF downloads come back base64-encoded in a small envelope.",
  "",
  "All tool calls act on the single Wafeq organization the configured credential",
  "belongs to; its name is reported on /health. `wafeq_request` is an escape hatch",
  "for endpoints missing from the bundled spec, not the primary interface.",
].join("\n");

/**
 * Which Wafeq organization this key is bound to.
 *
 * A Wafeq API key is organization-scoped, so a mis-set key does not fail loudly —
 * it succeeds against the wrong company's books. Resolving the tenant once at
 * startup and publishing it on /health turns that silent failure into something
 * visible before anything is written.
 */
export interface OrganizationIdentity {
  status: "ok" | "unauthorized" | "unreachable";
  id?: string;
  name?: string;
  base_currency?: string;
  country?: string;
  error?: string;
  checked_at: string;
}

export async function verifyOrganization(config: ServerConfig): Promise<OrganizationIdentity> {
  const checked_at = new Date().toISOString();
  try {
    const res = await callRaw(config, { method: "GET", path: "/organization/" });
    if (!res.ok) {
      return {
        status: res.status === 401 || res.status === 403 ? "unauthorized" : "unreachable",
        error: `HTTP ${res.status}`,
        checked_at,
      };
    }
    const org = res.body as {
      id?: string;
      name?: { en?: string; ar?: string } | string;
      financial_settings?: { base_currency?: string; country?: string };
    };
    const name = typeof org.name === "string" ? org.name : org.name?.en || org.name?.ar;
    return {
      status: "ok",
      id: org.id,
      name,
      base_currency: org.financial_settings?.base_currency,
      country: org.financial_settings?.country,
      checked_at,
    };
  } catch (err) {
    return { status: "unreachable", error: err instanceof Error ? err.message : String(err), checked_at };
  }
}

function describeOrganization(org: OrganizationIdentity): string {
  if (org.status === "ok") {
    return `Connected to organization: ${org.name ?? "(unnamed)"} (${org.id ?? "?"}), base currency ${org.base_currency ?? "?"}, country ${org.country ?? "?"}.`;
  }
  if (org.status === "unauthorized") {
    return `⚠️  Credentials rejected by Wafeq (${org.error}). Check WAFEQ_API_KEY / WAFEQ_ACCESS_TOKEN.`;
  }
  return `⚠️  Could not verify the organization (${org.error}). The server will start, but tool calls may fail.`;
}

function buildServer(tools: ToolDefinition[], config: ServerConfig): Server {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) return { isError: true, content: [{ type: "text" as const, text: `Unknown tool: ${name}` }] };

    try {
      if (tool.handler) {
        const result = await tool.handler((args ?? {}) as Record<string, unknown>);
        return { isError: result.isError === true, content: [{ type: "text" as const, text: result.text }] };
      }
      const result = await callOperation(config, tool.operation!, args ?? {});
      const summary = `HTTP ${result.status} ${result.ok ? "OK" : "ERROR"}`;
      return {
        isError: !result.ok,
        content: [{ type: "text" as const, text: `${summary}\n${stringify(result.body)}` }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text" as const, text: `Tool execution failed: ${message}` }] };
    }
  });

  return server;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Constant-time compare so the shared token can't be recovered by timing. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function runStdio(tools: ToolDefinition[], config: ServerConfig, org: OrganizationIdentity) {
  const server = buildServer(tools, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} (stdio) ready: ${tools.length} tools registered.`);
  console.error(describeOrganization(org));
}

async function runHttp(tools: ToolDefinition[], config: ServerConfig, org: OrganizationIdentity) {
  const port = parseInt(process.env.PORT ?? "8765", 10);
  const host = process.env.HOST ?? "0.0.0.0";
  const path = process.env.MCP_HTTP_PATH ?? "/mcp";
  const sharedToken = process.env.MCP_SHARED_TOKEN?.trim() || process.env.MCP_AUTH_TOKEN?.trim();

  type Session = { server: Server; transport: StreamableHTTPServerTransport };
  const sessions = new Map<string, Session>();

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }

    if (req.method === "GET" && req.url.split("?")[0] === "/health") {
      const healthy = org.status === "ok";
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: healthy ? "ok" : "degraded",
          server: SERVER_NAME,
          version: SERVER_VERSION,
          tools: tools.length,
          organization: org,
          auth_required: Boolean(sharedToken),
        }),
      );
      return;
    }

    if (!req.url.startsWith(path)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Not found. MCP endpoint is ${path}`);
      return;
    }

    if (sharedToken) {
      const auth = req.headers["authorization"];
      const provided = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "").trim() : "";
      if (!provided || !tokenMatches(provided, sharedToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
      let session: Session | undefined = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        const server = buildServer(tools, config);
        // Annotated because the callback below refers to `transport` from inside its
        // own initializer, which TypeScript cannot infer through.
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId) => {
            sessions.set(newId, { server, transport });
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) sessions.delete(id);
        };
        await server.connect(transport);
        session = { server, transport };
      }

      const body = req.method === "POST" ? await readBody(req) : undefined;
      await session.transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("Request handling error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      } else {
        res.end();
      }
    }
  });

  httpServer.listen(port, host, () => {
    console.error(`${SERVER_NAME} (http) ready on http://${host}:${port}${path} — ${tools.length} tools registered.`);
    console.error(describeOrganization(org));
    if (sharedToken) console.error("Bearer auth: required (MCP_SHARED_TOKEN set).");
    else console.error("Bearer auth: DISABLED — bind to localhost only.");
  });

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down…`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main() {
  const config = loadConfig();
  const { operations } = loadOpenApi(config.specPath);

  let tools = operationsToTools(operations);
  if (config.toolGroups.length > 0) {
    const groups = availableGroups(tools);
    const unknown = config.toolGroups.filter((g) => !groups.includes(normalizeGroup(g)));
    if (unknown.length > 0) {
      console.error(`⚠️  WAFEQ_TOOL_GROUPS contains unknown group(s): ${unknown.join(", ")}`);
      console.error(`    Available groups: ${groups.join(", ")}`);
    }
    tools = filterToolsByGroup(tools, config.toolGroups);
  }
  tools = [...tools, ...extraTools(config)];

  // Resolve the tenant before serving, so /health and the startup log can name it.
  const org = await verifyOrganization(config);

  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http" || transport === "streamable-http") {
    await runHttp(tools, config, org);
  } else if (transport === "stdio") {
    await runStdio(tools, config, org);
  } else {
    throw new Error(`Unknown MCP_TRANSPORT: ${transport}. Use "stdio" or "http".`);
  }
}

main().catch((err) => {
  console.error(`Fatal error starting ${SERVER_NAME}:`, err);
  process.exit(1);
});
