import { categorize, type CategoryInfo } from "./categorize.js";
import { compactEnumDescriptions, IDEMPOTENCY_HEADER, type JsonSchema, type Operation, type ParameterSpec } from "./openapi.js";
import { OPERATION_NOTES } from "./overrides.js";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * What a hand-written tool returns. `isError` is explicit rather than inferred, so a
 * passthrough call that comes back HTTP 404 is reported to the model as an error
 * instead of as a successful result whose body happens to say "not found".
 */
export interface HandlerResult {
  text: string;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  category: CategoryInfo;
  /** Absent on the hand-written tools (passthrough, account ledger). */
  operation?: Operation;
  /** Handler for hand-written tools; generated tools go through `callOperation`. */
  handler?: (args: Record<string, unknown>) => Promise<HandlerResult>;
}

const MCP_TOOL_NAME_MAX = 64;
export const TOOL_PREFIX = "wafeq_";

/** Friendly alias for the {@link IDEMPOTENCY_HEADER} header. */
export const IDEMPOTENCY_ARG = "idempotency_key";
/** Built from `filename` on raw uploads, never exposed as an argument. */
const CONTENT_DISPOSITION = "content-disposition";

function snakeCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

/**
 * Parameters the transport fills in itself, so they must not become tool arguments.
 * The idempotency header is replaced by the friendlier {@link IDEMPOTENCY_ARG};
 * `Content-Disposition` is derived from the upload's `filename`.
 */
function isHandledInternally(op: Operation, p: ParameterSpec): boolean {
  if (p.in !== "header") return false;
  const lower = p.name.toLowerCase();
  if (lower === IDEMPOTENCY_HEADER.toLowerCase()) return true;
  if (lower === CONTENT_DISPOSITION && (op.multipart || op.rawBinaryUpload)) return true;
  return false;
}

function paramToSchema(p: ParameterSpec): JsonSchema {
  const base: Record<string, unknown> = { ...(p.schema ?? { type: "string" }) };
  if (p.description && !base.description) base.description = p.description;
  if (p.argName && p.argName !== p.name) {
    base.description = [base.description, `Sent to Wafeq as "${p.name}".`].filter(Boolean).join(" ");
  }
  // Compact last: the parameter-level description is merged in above, and it is the
  // one carrying the enum's bullet list.
  return compactEnumDescriptions(base);
}

/** The `file_*` arguments shared by both upload endpoints. */
function fileUploadProperties(): Record<string, unknown> {
  return {
    file_base64: {
      type: "string",
      description:
        "File contents, base64-encoded. Provide either this or `file_path`. Prefer this for content you already hold.",
    },
    file_path: {
      type: "string",
      description:
        "Absolute path to a file on the machine running this MCP server. Disabled unless WAFEQ_ALLOW_LOCAL_FILE_UPLOAD=true.",
    },
    filename: {
      type: "string",
      description: "Name to store the file under, e.g. \"receipt-2026-03.pdf\". Required.",
    },
    content_type: {
      type: "string",
      description: "MIME type, e.g. \"application/pdf\". Guessed from the filename extension when omitted.",
    },
  };
}

function buildInputSchema(op: Operation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of op.parameters) {
    if (isHandledInternally(op, p)) continue;
    const key = p.argName ?? p.name;
    properties[key] = paramToSchema(p);
    if (p.required) required.push(key);
  }

  if (op.multipart || op.rawBinaryUpload) {
    Object.assign(properties, fileUploadProperties());
    required.push("filename");
  } else if (op.requestBodySchema) {
    properties.body = {
      description: `Request body (${op.requestBodyContentType ?? "application/json"}).`,
      ...op.requestBodySchema,
    };
    if (op.requestBodyRequired) required.push("body");
  }

  if (op.supportsIdempotencyKey) {
    properties[IDEMPOTENCY_ARG] = {
      type: "string",
      description:
        "Optional idempotency key (sent as the X-Wafeq-Idempotency-Key header). A UUID v4 is generated automatically " +
        "when omitted, so an automatic network retry can never duplicate this operation. Pass your own stable value to " +
        "make a deliberate re-invocation safe as well.",
    };
  }

  const schema: Record<string, unknown> = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = [...new Set(required)];
  return schema;
}

function buildDescription(op: Operation, category: CategoryInfo): string {
  const lines: string[] = [];
  const tag = op.tags[0] ?? "General";
  lines.push(`${category.banner} · ${tag} · ${op.method.toUpperCase()} ${op.path}`);
  if (op.summary) lines.push(op.summary);
  if (op.description && op.description.trim() !== op.summary?.trim()) {
    const desc = op.description.trim();
    lines.push(desc.length > 600 ? desc.slice(0, 600) + "…" : desc);
  }
  if (category.note) lines.push(category.note);
  const override = OPERATION_NOTES[op.operationId];
  if (override) lines.push(override);
  return lines.join("\n\n");
}

function buildAnnotations(category: CategoryInfo, title: string): ToolAnnotations {
  return {
    title,
    readOnlyHint: category.readOnlyHint,
    destructiveHint: category.destructiveHint,
    idempotentHint: category.idempotentHint,
    openWorldHint: true,
  };
}

/**
 * Names come from `operationId`, not from the summary. Wafeq's ids are already
 * snake_case, unique across all 251 operations, and stable across documentation
 * rewordings — so a spec drop-in does not silently rename every tool (which would
 * break saved prompts and host allow-lists). The summary becomes the display title.
 */
export function toolName(op: Operation): string {
  const base = snakeCase(op.operationId) || snakeCase(`${op.method}_${op.path}`);
  return `${TOOL_PREFIX}${base}`.slice(0, MCP_TOOL_NAME_MAX);
}

export function operationsToTools(operations: Operation[]): ToolDefinition[] {
  const used = new Set<string>();
  const tools: ToolDefinition[] = [];

  for (const op of operations) {
    let name = toolName(op);
    if (used.has(name)) {
      // Defensive: a future spec could reuse an operationId across paths.
      const tagged = `${name}_${snakeCase(op.tags[0] ?? op.method)}`.slice(0, MCP_TOOL_NAME_MAX);
      let candidate = tagged;
      let i = 2;
      while (used.has(candidate)) candidate = `${tagged.slice(0, MCP_TOOL_NAME_MAX - 3)}_${i++}`;
      name = candidate;
    }
    used.add(name);

    const category = categorize(op);
    const title = op.summary?.trim() || op.operationId;

    tools.push({
      name,
      description: buildDescription(op, category),
      inputSchema: buildInputSchema(op),
      annotations: buildAnnotations(category, title),
      category,
      operation: op,
    });
  }

  return tools;
}

/**
 * Canonical form of a group name: `Bank Accounts`, `bank-accounts` and
 * `bank_accounts` all name the same group. Exported so the startup warning and the
 * filter itself cannot disagree about what counts as a valid name.
 */
export const normalizeGroup = (name: string): string => snakeCase(name);

/**
 * Restrict the catalogue to the given tag/resource groups.
 *
 * 251 tools is a lot for one server and some hosts slow down or start mis-selecting
 * with that many, so `WAFEQ_TOOL_GROUPS` can narrow it. Matching is
 * case-insensitive against the operation's tag and its first path segment, so both
 * "Invoices" and "invoices" select the same set. The hand-written tools always
 * survive: they are the escape hatch.
 */
export function filterToolsByGroup(tools: ToolDefinition[], groups: string[]): ToolDefinition[] {
  if (groups.length === 0) return tools;
  const wanted = new Set(groups.map(normalizeGroup));
  return tools.filter((t) => {
    if (!t.operation) return true;
    const tag = snakeCase(t.operation.tags[0] ?? "");
    const resource = snakeCase(t.operation.path.split("/")[1] ?? "");
    return wanted.has(tag) || wanted.has(resource);
  });
}

/** Every group name accepted by {@link filterToolsByGroup}, for error messages and docs. */
export function availableGroups(tools: ToolDefinition[]): string[] {
  const set = new Set<string>();
  for (const t of tools) {
    if (!t.operation) continue;
    set.add(snakeCase(t.operation.path.split("/")[1] ?? ""));
  }
  set.delete("");
  return [...set].sort();
}
