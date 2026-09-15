#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
import {
  bearerFrom,
  healthHostAllowlist,
  hostAllowed,
  hostAllowlist,
  loadHttpConfig,
  startupRefusal,
  tokenMatches,
  weakTokenWarning,
} from "./http.js";

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

class BodyTooLarge extends Error {}

/**
 * Reads the request body, refusing anything over `limitBytes`. Without the
 * limit the whole request is buffered in memory, and with no token set anyone
 * who could reach the port could send a body of any size.
 */
async function readBody(
  req: IncomingMessage,
  limitBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) {
      // Throwing out of `for await` already destroys the request and nulls its
      // socket, so neither req.pause() nor a later req.destroy() does anything.
      // The response socket is still alive, which is all the caller needs to
      // write the 413.
      throw new BodyTooLarge(`Request body exceeds ${limitBytes} bytes`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function runStdio(tools: ToolDefinition[], config: ServerConfig, org: OrganizationIdentity) {
  const server = buildServer(tools, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} (stdio) ready: ${tools.length} tools registered.`);
  console.error(describeOrganization(org));
}

async function runHttp(tools: ToolDefinition[], config: ServerConfig, org: OrganizationIdentity) {
  const cfg = loadHttpConfig();

  // A server reachable beyond this machine must require a token. This endpoint
  // can read, write and delete real accounting records, so starting it wide
  // open is refused rather than warned about.
  const refusal = startupRefusal(cfg);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  if (cfg.portFellBack) {
    console.error(
      `${SERVER_NAME}: WARNING - PORT=${process.env.PORT} is not a usable ` +
        `port number, falling back to ${cfg.port}. A platform that injects ` +
        `PORT will probe the value it injected, not this one.`,
    );
  }
  const weak = weakTokenWarning(cfg);
  if (weak) console.error(`${SERVER_NAME}: ${weak}`);
  if (!cfg.authToken && cfg.allowInsecure) {
    console.error(
      `${SERVER_NAME}: WARNING - MCP_ALLOW_INSECURE is set and no ` +
        "MCP_AUTH_TOKEN is configured. Anyone who can reach this port has " +
        "full read/write/delete access to the accounting data.",
    );
  }

  const allowlist = hostAllowlist(cfg);
  const healthAllowlist = healthHostAllowlist(cfg);

  type Session = {
    server: Server;
    transport: StreamableHTTPServerTransport;
    lastSeen: number;
    /** Open SSE streams; a session serving one is in use, however quiet. */
    streams: number;
  };
  const sessions = new Map<string, Session>();

  const drop = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void Promise.resolve(s.transport.close()).catch(() => {});
  };

  // Sessions were previously only removed when the transport closed, and each
  // one holds a full Server instance. A client that reconnects instead of
  // closing grew the map until the process died.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - cfg.sessionTtlMs;
    for (const [id, s] of sessions) {
      if (s.streams === 0 && s.lastSeen < cutoff) drop(id);
    }
  }, 60_000);
  sweep.unref();

  const evictOldest = () => {
    let victim: string | undefined;
    let oldest = Infinity;
    let victimStreaming = true;
    for (const [id, s] of sessions) {
      const streaming = s.streams > 0;
      // A non-streaming candidate always beats a streaming one.
      if (victimStreaming && !streaming) {
        victim = id;
        oldest = s.lastSeen;
        victimStreaming = false;
        continue;
      }
      if (streaming === victimStreaming && s.lastSeen < oldest) {
        victim = id;
        oldest = s.lastSeen;
      }
    }
    if (victim) drop(victim);
  };

  const send = (res: ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const rpcError = (code: number, message: string) => ({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }

    // 1. DNS-rebinding protection, on every route: /health used to answer with
    //    any Host header.
    const listForRequest =
      req.method === "GET" && (req.url === "/health" || req.url.startsWith("/health?"))
        ? healthAllowlist
        : allowlist;
    if (listForRequest && !hostAllowed(req.headers.host, listForRequest)) {
      send(res, 403, rpcError(-32000, `Invalid Host: ${req.headers.host ?? "(missing)"}`));
      return;
    }

    // Parse once: req.url carries the query string, and startsWith() turned
    // /mcpXYZ and /mcp-evil into fully working MCP endpoints, which silently
    // defeats any WAF rule, proxy route or rate limit scoped to exactly /mcp.
    const pathname = (() => {
      try {
        return new URL(req.url!, "http://localhost").pathname;
      } catch {
        return req.url!;
      }
    })();
    const isMcpPath = pathname === cfg.path || pathname.startsWith(cfg.path + "/");

    // Liveness only. Behind the Host check, in front of the auth gate so a
    // platform health check needs no token. The healthy/degraded distinction is
    // kept because a platform acts on it, but the organization identity, the
    // version, the tool count and whether auth is on are no longer handed to an
    // unauthenticated caller: that told an attacker whose books these are and
    // whether they are protected at all.
    if (req.method === "GET" && pathname === "/health") {
      const healthy = org.status === "ok";
      send(res, healthy ? 200 : 503, {
        status: healthy ? "ok" : "degraded",
        server: SERVER_NAME,
      });
      return;
    }

    if (!isMcpPath) {
      send(res, 404, rpcError(-32601, `Not found. MCP endpoint is ${cfg.path}`));
      return;
    }

    // 2. Shared secret, still before the body is read. The comparison hashes
    //    both sides first, so it no longer returns early on a length mismatch,
    //    which leaked the token length.
    if (cfg.authToken && !tokenMatches(bearerFrom(req.headers.authorization), cfg.authToken)) {
      send(res, 401, rpcError(-32001, "Unauthorized"));
      return;
    }

    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      // 3. Body first, so an initialize can be recognised without allocating.
      let body: unknown;
      if (req.method === "POST") {
        try {
          body = await readBody(req, cfg.bodyLimitBytes);
        } catch (err) {
          if (err instanceof BodyTooLarge) {
            send(res, 413, rpcError(-32600, `Request body exceeds the configured limit of ${cfg.bodyLimitBytes} bytes`));
            return;
          }
          throw err;
        }
      }

      let session: Session | undefined;

      if (sessionId) {
        session = sessions.get(sessionId);
        if (!session) {
          // 404, not a silent new session: this used to build a fresh Server
          // for any session id it did not recognise, so a client that sent a
          // stale id got a working but empty session instead of being told to
          // re-initialize, and nothing capped how many were created.
          send(res, 404, rpcError(-32001, "Session not found"));
          return;
        }
        session.lastSeen = Date.now();
      } else if (req.method === "POST" && isInitializeRequest(body)) {
        if (sessions.size >= cfg.maxSessions) evictOldest();
        const server = buildServer(tools, config);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId) => {
            sessions.set(newId, { server, transport, lastSeen: Date.now(), streams: 0 });
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) sessions.delete(id);
        };
        await server.connect(transport);
        session = { server, transport, lastSeen: Date.now(), streams: 0 };
      } else {
        send(res, req.method === "POST" ? 400 : 404, rpcError(-32000, "Bad Request: no valid session ID provided."));
        return;
      }

      // A GET is the SSE stream and stays open; count it so the idle sweep
      // leaves the session alone while it is genuinely in use.
      if (req.method === "GET" && sessionId) {
        const held = session;
        held.streams += 1;
        res.on("close", () => {
          held.streams = Math.max(0, held.streams - 1);
          held.lastSeen = Date.now();
        });
      }

      await session.transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("Request handling error:", err);
      if (!res.headersSent) {
        send(res, 500, rpcError(-32603, "Internal server error"));
      } else {
        res.end();
      }
    }
  });

  // Without this a failed bind was silent: nothing listened, nothing was
  // logged, and the process stayed up as if it had started.
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    const hint =
      err.code === "EADDRINUSE"
        ? ` Port ${cfg.port} is already in use.`
        : err.code === "EACCES"
          ? ` No permission to bind port ${cfg.port}.`
          : err.code === "ENOTFOUND" || err.code === "EADDRNOTAVAIL"
            ? ` HOST=${cfg.host} is not an address this machine can bind.`
            : "";
    console.error(
      `Fatal: could not listen on ${cfg.host}:${cfg.port}.${hint} (${err.code ?? err.message})`,
    );
    process.exit(1);
  });

  httpServer.listen(cfg.port, cfg.host, () => {
    console.error(
      `${SERVER_NAME} (http) ready on http://${cfg.host}:${cfg.port}${cfg.path} - ${tools.length} tools registered.`,
    );
    console.error(describeOrganization(org));
    if (allowlist) {
      console.error(`${SERVER_NAME}: Host header restricted to ${allowlist.join(", ")}`);
    }
    if (cfg.authToken) console.error("Bearer auth: required (MCP_AUTH_TOKEN set).");
    else console.error("Bearer auth: DISABLED (MCP_AUTH_TOKEN not set).");
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
