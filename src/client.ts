import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { IDEMPOTENCY_HEADER, type Operation } from "./openapi.js";
import { checkPeriodAlignment } from "./overrides.js";
import type { RateLimiter } from "./rateLimiter.js";
import { IDEMPOTENCY_ARG } from "./tools.js";

export type AuthScheme = "api-key" | "bearer";

export interface WafeqConfig {
  baseUrl: string;
  /** The raw credential. Never exposed to the model; injected per request. */
  apiToken: string;
  /** `Api-Key <key>` for private org keys, `Bearer <token>` for OAuth2 apps. */
  authScheme: AuthScheme;
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Max automatic retries on 429 / 5xx / network errors. Default 3. */
  maxRetries?: number;
  /** Per-attempt request timeout in ms. Default 30000. */
  timeoutMs?: number;
  rateLimiter?: RateLimiter;
  /** Allow upload tools to read files from this machine's filesystem. Default false. */
  allowLocalFileUpload?: boolean;
  /** Cap on a decoded upload, in bytes. Default 25 MiB. */
  maxUploadBytes?: number;
}

export interface CallResult {
  status: number;
  ok: boolean;
  contentType: string | null;
  body: unknown;
  /** Number of retries performed before this response was returned. */
  attempts: number;
  /** Set when the response was binary and `body` holds the base64 envelope. */
  binary?: boolean;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/** Exponential backoff with full jitter, capped, so retries don't thunder. */
function backoffDelay(attempt: number, base = 500, cap = 8000): number {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/** The input-schema key a parameter's value arrives under (see ParameterSpec.argName). */
const argKey = (p: { name: string; argName?: string }): string => p.argName ?? p.name;

function expandPath(op: Operation, args: Record<string, unknown>, consumed: Set<string>): string {
  const pathParams = new Map(op.parameters.filter((p) => p.in === "path").map((p) => [p.name, p]));
  return op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const key = pathParams.has(name) ? argKey(pathParams.get(name)!) : name;
    if (!(key in args)) throw new Error(`Missing required path parameter "${key}".`);
    consumed.add(key);
    const v = args[key];
    if (v === null || v === undefined) throw new Error(`Path parameter "${key}" cannot be null/undefined.`);
    return encodeURIComponent(String(v));
  });
}

function buildQueryString(op: Operation, args: Record<string, unknown>, consumed: Set<string>): string {
  const usp = new URLSearchParams();
  for (const p of op.parameters) {
    if (p.in !== "query") continue;
    const key = argKey(p);
    if (consumed.has(key)) continue;
    const value = args[key];
    if (value === undefined || value === null) continue;
    consumed.add(key);
    if (Array.isArray(value)) {
      // Wafeq's `__in` filters repeat the key; that is also OpenAPI's `explode: true` default.
      const explode = p.explode !== false;
      if (explode) for (const v of value) usp.append(p.name, String(v));
      else usp.append(p.name, value.map((v) => String(v)).join(","));
    } else if (typeof value === "object") {
      usp.append(p.name, JSON.stringify(value));
    } else {
      usp.append(p.name, String(value));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

function collectHeaderParams(op: Operation, args: Record<string, unknown>, consumed: Set<string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const p of op.parameters) {
    if (p.in !== "header") continue;
    const key = argKey(p);
    if (consumed.has(key)) continue;
    const value = args[key];
    if (value === undefined || value === null) continue;
    consumed.add(key);
    headers[p.name] = String(value);
  }
  return headers;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  csv: "text/csv",
  txt: "text/plain",
  xml: "application/xml",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function guessContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

interface UploadPayload {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

/** Resolve the upload arguments into bytes, from base64 or (if permitted) from disk. */
async function resolveUpload(cfg: WafeqConfig, args: Record<string, unknown>): Promise<UploadPayload> {
  const b64 = typeof args.file_base64 === "string" ? args.file_base64 : undefined;
  const path = typeof args.file_path === "string" ? args.file_path : undefined;

  if (!b64 && !path) throw new Error("Provide either `file_base64` (file contents, base64-encoded) or `file_path`.");
  if (b64 && path) throw new Error("Provide only one of `file_base64` or `file_path`, not both.");

  let bytes: Uint8Array;
  let derivedName: string | undefined;

  if (b64) {
    // Buffer.from is lenient about non-base64 input, so verify by round-tripping.
    const cleaned = b64.replace(/\s+/g, "");
    const buf = Buffer.from(cleaned, "base64");
    if (buf.length === 0 && cleaned.length > 0) throw new Error("`file_base64` is not valid base64.");
    bytes = new Uint8Array(buf);
  } else {
    if (!cfg.allowLocalFileUpload) {
      throw new Error(
        "`file_path` is disabled. This server will not read files from its own filesystem unless " +
          "WAFEQ_ALLOW_LOCAL_FILE_UPLOAD=true is set. Pass the contents as `file_base64` instead.",
      );
    }
    if (!isAbsolute(path!)) throw new Error("`file_path` must be an absolute path.");
    bytes = new Uint8Array(await readFile(path!));
    derivedName = basename(path!);
  }

  const max = cfg.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (bytes.byteLength > max) {
    throw new Error(`Upload is ${bytes.byteLength} bytes, over the ${max}-byte limit (WAFEQ_MAX_UPLOAD_BYTES).`);
  }

  const filename = typeof args.filename === "string" && args.filename.trim() ? args.filename.trim() : derivedName;
  if (!filename) throw new Error("`filename` is required.");

  const contentType =
    typeof args.content_type === "string" && args.content_type.trim()
      ? args.content_type.trim()
      : guessContentType(filename);

  return { bytes, filename, contentType };
}

/** RFC 6266 filename, ASCII-quoted with a UTF-8 fallback for non-ASCII names. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/["\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Perform a request with a timeout, retrying transient failures (429 / 5xx /
 * network errors) with jittered exponential backoff, honouring `Retry-After`.
 *
 * `makeInit` is a factory rather than a value because a multipart body is a
 * one-shot stream: reusing the same `RequestInit` across attempts would send an
 * already-consumed body on the retry. The headers it returns are built once by the
 * caller, so the idempotency key stays identical across attempts — which is exactly
 * what Wafeq's integration guide requires of a retry.
 */
async function fetchWithResilience(
  fetchImpl: typeof fetch,
  url: string,
  makeInit: () => RequestInit,
  cfg: WafeqConfig,
): Promise<{ response: Response; attempts: number }> {
  const maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (cfg.rateLimiter) await cfg.rateLimiter.acquire();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...makeInit(), signal: controller.signal });
      clearTimeout(timer);

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        const wait = parseRetryAfter(response.headers.get("retry-after")) ?? backoffDelay(attempt);
        // Drain the body so the socket can be reused, then retry.
        await response.text().catch(() => undefined);
        await sleep(wait);
        continue;
      }

      return { response, attempts: attempt };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      lastError = isAbort ? new Error(`Request timed out after ${timeoutMs}ms.`) : err;
      if (attempt < maxRetries) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error("Request failed after exhausting retries.");
}

export function authorizationHeader(cfg: WafeqConfig): string {
  const token = cfg.apiToken.trim();
  // Accept a token that already carries its scheme, so a pasted header still works.
  if (/^(Api-Key|Bearer)\s/i.test(token)) return token;
  return cfg.authScheme === "bearer" ? `Bearer ${token}` : `Api-Key ${token}`;
}

export async function callOperation(
  cfg: WafeqConfig,
  op: Operation,
  rawArgs: unknown,
): Promise<CallResult> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const fetchImpl = cfg.fetchImpl ?? fetch;

  // Observed-behaviour guard: reject a misaligned report range locally, with the
  // corrected range, rather than spending a round trip to be told the same thing.
  const periodError = checkPeriodAlignment(op.operationId, args);
  if (periodError) throw new Error(periodError);

  // Reserve the names this layer consumes itself, so they are not also sent as
  // query/header parameters. The upload names are reserved only on upload
  // operations, so a future spec that adds a real `filename` query parameter
  // elsewhere still works.
  const consumed = new Set<string>([IDEMPOTENCY_ARG]);
  if (op.multipart || op.rawBinaryUpload) {
    for (const key of ["file_base64", "file_path", "filename", "content_type"]) consumed.add(key);
  }
  const expandedPath = expandPath(op, args, consumed);
  const query = buildQueryString(op, args, consumed);
  const headerParams = collectHeaderParams(op, args, consumed);

  const headers: Record<string, string> = {
    Accept: op.binaryResponseType ? `${op.binaryResponseType}, application/json` : "application/json",
    Authorization: authorizationHeader(cfg),
    ...headerParams,
    ...(cfg.extraHeaders ?? {}),
  };

  // One key for the whole call, including every retry — a retry must not look like
  // a new operation to Wafeq.
  if (op.supportsIdempotencyKey) {
    const supplied = args[IDEMPOTENCY_ARG];
    headers[IDEMPOTENCY_HEADER] =
      typeof supplied === "string" && supplied.trim() ? supplied.trim() : randomUUID();
  }

  // `RequestInit["body"]` rather than `BodyInit`: the latter is a DOM global, and this
  // package compiles against the Node types only.
  let makeBody: () => RequestInit["body"] = () => undefined;

  if (op.multipart) {
    const upload = await resolveUpload(cfg, args);
    // Content-Type must be left to fetch so it can add the multipart boundary.
    makeBody = () => {
      const form = new FormData();
      form.append("file", new Blob([upload.bytes], { type: upload.contentType }), upload.filename);
      return form;
    };
  } else if (op.rawBinaryUpload) {
    const upload = await resolveUpload(cfg, args);
    headers["Content-Type"] = upload.contentType;
    headers["Content-Disposition"] = contentDisposition(upload.filename);
    makeBody = () => upload.bytes;
  } else if (op.requestBodySchema && args.body !== undefined) {
    headers["Content-Type"] = op.requestBodyContentType ?? "application/json";
    const serialized = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
    makeBody = () => serialized;
  }

  const url = `${cfg.baseUrl.replace(/\/+$/, "")}${expandedPath}${query}`;
  const method = op.method.toUpperCase();

  const { response, attempts } = await fetchWithResilience(
    fetchImpl,
    url,
    () => ({ method, headers, body: makeBody() }),
    cfg,
  );

  return await readResponse(response, attempts, op);
}

/**
 * Decode a response. Binary success responses (the nine PDF endpoints) are
 * base64-encoded into a small envelope instead of being read as text, which would
 * corrupt them. Errors are always read as text, because Wafeq answers a failed PDF
 * request with a JSON error body, not a PDF.
 */
export async function readResponse(response: Response, attempts: number, op?: Operation): Promise<CallResult> {
  const contentType = response.headers.get("content-type");
  const isBinary =
    response.ok &&
    Boolean(contentType) &&
    !contentType!.includes("application/json") &&
    !contentType!.startsWith("text/") &&
    (Boolean(op?.binaryResponseType) || contentType!.includes("application/pdf") || contentType!.includes("octet-stream"));

  if (isBinary) {
    const buf = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      ok: response.ok,
      contentType,
      binary: true,
      attempts,
      body: {
        encoding: "base64",
        content_type: contentType,
        size_bytes: buf.byteLength,
        filename: filenameFromDisposition(response.headers.get("content-disposition")),
        data: buf.toString("base64"),
      },
    };
  }

  const rawBody = await response.text();
  let parsedBody: unknown = rawBody;
  if (rawBody.length === 0) {
    parsedBody = response.status === 204 ? { deleted: true, status: 204 } : "";
  } else if (contentType?.includes("application/json")) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }

  return { status: response.status, ok: response.ok, contentType, body: parsedBody, attempts };
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : undefined;
}

// Exposed for unit tests.
export const __test = { parseRetryAfter, backoffDelay, RETRYABLE_STATUS, resolveUpload, filenameFromDisposition };

export interface RawRequestOptions {
  method: string;
  /** Path relative to the base URL, or an absolute URL on the same host (e.g. a `next` link). */
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Escape hatch: call any endpoint, with full control over headers.
 *
 * Shares the retry, timeout and rate-limit machinery with the generated tools, so
 * the fallback path is no less resilient than the primary one. Caller-supplied
 * headers win over the defaults except for `Authorization`, which is always taken
 * from the environment — a model must not be able to redirect the credential or
 * substitute one of its own.
 */
export async function callRaw(cfg: WafeqConfig, opts: RawRequestOptions): Promise<CallResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/+$/, "");

  let url: string;
  if (/^https?:\/\//i.test(opts.path)) {
    const target = new URL(opts.path);
    const allowed = new URL(base);
    if (target.host !== allowed.host) {
      throw new Error(`Refusing to send credentials to ${target.host}; this server only talks to ${allowed.host}.`);
    }
    url = target.toString();
  } else {
    url = `${base}/${opts.path.replace(/^\/+/, "")}`;
  }

  if (opts.query && Object.keys(opts.query).length > 0) {
    const parsed = new URL(url);
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const item of v) parsed.searchParams.append(k, String(item));
      else parsed.searchParams.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    url = parsed.toString();
  }

  const method = opts.method.toUpperCase();
  const headers: Record<string, string> = { Accept: "application/json" };
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (k.toLowerCase() === "authorization") continue; // never overridable
    headers[k] = String(v);
  }
  headers.Authorization = authorizationHeader(cfg);

  let body: string | undefined;
  if (opts.body !== undefined && opts.body !== null && method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] ??= "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }

  // A write through the escape hatch gets the same duplicate protection as a
  // generated one, unless the caller supplied a key of their own.
  if (method !== "GET" && method !== "HEAD" && !Object.keys(headers).some((h) => h.toLowerCase() === IDEMPOTENCY_HEADER.toLowerCase())) {
    headers[IDEMPOTENCY_HEADER] = randomUUID();
  }

  const { response, attempts } = await fetchWithResilience(fetchImpl, url, () => ({ method, headers, body }), cfg);
  return await readResponse(response, attempts);
}
