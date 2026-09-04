import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthScheme, WafeqConfig } from "./client.js";
import { RateLimiter } from "./rateLimiter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerConfig extends WafeqConfig {
  specPath: string;
  /** Empty means "expose every tool". */
  toolGroups: string[];
}

export const DEFAULT_BASE_URL = "https://api.wafeq.com/v1";

// Wafeq publishes no numeric rate limit, only "429 is possible; back off". These
// defaults are deliberately conservative; raise them if your plan allows.
const DEFAULT_MAX_REQUESTS = 20;
const DEFAULT_RATE_WINDOW_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function boolEnv(name: string, fallback = false): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function resolveSpecPath(): string {
  const explicit = process.env.WAFEQ_OPENAPI_PATH;
  if (explicit) {
    const abs = resolve(explicit);
    if (!existsSync(abs)) throw new Error(`WAFEQ_OPENAPI_PATH not found: ${abs}`);
    return abs;
  }
  // Bundled spec: dist/ (or src/) is a sibling of spec/ at the package root.
  for (const candidate of [
    resolve(__dirname, "..", "spec", "wafeq-public-api.json"),
    resolve(__dirname, "..", "..", "spec", "wafeq-public-api.json"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Could not locate the Wafeq OpenAPI spec. Set WAFEQ_OPENAPI_PATH to the JSON or YAML file.");
}

/**
 * Resolve the credential and its header scheme.
 *
 * Wafeq accepts two schemes on the same `Authorization` header: `Api-Key <key>` for
 * a private, organization-scoped key, and `Bearer <token>` for an OAuth2 app. The
 * scheme is inferred from which variable is set — setting WAFEQ_ACCESS_TOKEN means
 * OAuth2 — and WAFEQ_AUTH_SCHEME overrides that when both are somehow present.
 */
function resolveAuth(): { apiToken: string; authScheme: AuthScheme } {
  const apiKey = process.env.WAFEQ_API_KEY?.trim();
  const accessToken = process.env.WAFEQ_ACCESS_TOKEN?.trim();
  const override = process.env.WAFEQ_AUTH_SCHEME?.trim().toLowerCase();

  if (override && override !== "api-key" && override !== "bearer") {
    throw new Error(`WAFEQ_AUTH_SCHEME must be "api-key" or "bearer", got "${override}".`);
  }

  if (override === "bearer") {
    const token = accessToken || apiKey;
    if (!token) throw new Error("WAFEQ_AUTH_SCHEME=bearer requires WAFEQ_ACCESS_TOKEN (or WAFEQ_API_KEY).");
    return { apiToken: token, authScheme: "bearer" };
  }
  if (override === "api-key") {
    if (!apiKey) throw new Error("WAFEQ_AUTH_SCHEME=api-key requires WAFEQ_API_KEY.");
    return { apiToken: apiKey, authScheme: "api-key" };
  }

  if (accessToken) return { apiToken: accessToken, authScheme: "bearer" };
  if (apiKey) return { apiToken: apiKey, authScheme: "api-key" };

  throw new Error(
    "Missing credentials. Set WAFEQ_API_KEY (private organization key, sent as `Api-Key <key>`) " +
      "or WAFEQ_ACCESS_TOKEN (OAuth2 app token, sent as `Bearer <token>`). See README.md.",
  );
}

function parseGroups(): string[] {
  const raw = process.env.WAFEQ_TOOL_GROUPS?.trim();
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): ServerConfig {
  const maxRequests = intEnv("WAFEQ_MAX_REQUESTS", DEFAULT_MAX_REQUESTS);
  const windowMs = intEnv("WAFEQ_RATE_WINDOW_MS", DEFAULT_RATE_WINDOW_MS);
  const { apiToken, authScheme } = resolveAuth();

  return {
    baseUrl: (process.env.WAFEQ_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiToken,
    authScheme,
    specPath: resolveSpecPath(),
    toolGroups: parseGroups(),
    maxRetries: intEnv("WAFEQ_MAX_RETRIES", DEFAULT_MAX_RETRIES),
    timeoutMs: intEnv("WAFEQ_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    allowLocalFileUpload: boolEnv("WAFEQ_ALLOW_LOCAL_FILE_UPLOAD", false),
    maxUploadBytes: intEnv("WAFEQ_MAX_UPLOAD_BYTES", 25 * 1024 * 1024),
    // 0 disables client-side throttling; retries on 429 still apply.
    rateLimiter: maxRequests > 0 ? new RateLimiter(maxRequests, windowMs) : undefined,
  };
}
