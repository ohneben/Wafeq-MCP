import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WafeqConfig } from "../client.js";
import { CATEGORY_LABEL, CATEGORY_ORDER, type Category } from "../categorize.js";
import { extraTools } from "../extraTools.js";
import { loadOpenApi } from "../openapi.js";
import { availableGroups, operationsToTools, type ToolDefinition } from "../tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findSpec(): string {
  if (process.env.WAFEQ_OPENAPI_PATH) return resolve(process.env.WAFEQ_OPENAPI_PATH);
  for (const candidate of [
    resolve(__dirname, "..", "..", "spec", "wafeq-public-api.json"),
    resolve(__dirname, "..", "..", "..", "spec", "wafeq-public-api.json"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Spec not found. Set WAFEQ_OPENAPI_PATH.");
}

// The catalogue is a static view of the spec, so it runs without credentials.
// This placeholder is never used to make a request.
const OFFLINE_CONFIG = { baseUrl: "https://api.wafeq.com/v1", apiToken: "", authScheme: "api-key" } as WafeqConfig;

const specPath = findSpec();
const { operations, doc } = loadOpenApi(specPath);
const generated = operationsToTools(operations);
const tools: ToolDefinition[] = [...generated, ...extraTools(OFFLINE_CONFIG)];

const pad = (n: number, w = 4) => String(n).padStart(w);

console.log(`Spec:  ${specPath}`);
console.log(`Title: ${doc.info?.title ?? "(untitled)"} ${doc.info?.version ?? ""}`);
console.log(`Loaded ${operations.length} operations → ${generated.length} generated tools + ${tools.length - generated.length} hand-written = ${tools.length} total.\n`);

const byCategory = new Map<Category, ToolDefinition[]>();
for (const t of tools) {
  const list = byCategory.get(t.category.category) ?? [];
  list.push(t);
  byCategory.set(t.category.category, list);
}

console.log("SAFETY CATEGORIES");
console.log("─".repeat(78));
for (const cat of CATEGORY_ORDER) {
  const list = byCategory.get(cat);
  if (!list || list.length === 0) continue;
  console.log(`  ${list[0].category.icon}  ${CATEGORY_LABEL[cat].padEnd(32)} ${pad(list.length)}`);
}
console.log("─".repeat(78));
const readable = tools.filter((t) => t.annotations.readOnlyHint).length;
const confirm = tools.filter((t) => t.annotations.destructiveHint).length;
console.log(`  ${"auto-trustable (readOnlyHint)".padEnd(36)} ${pad(readable)}`);
console.log(`  ${"needs confirmation (destructiveHint)".padEnd(36)} ${pad(confirm)}`);
console.log(`  ${"TOTAL".padEnd(36)} ${pad(tools.length)}\n`);

console.log("COVERAGE BY RESOURCE  (read / write / irreversible / delete)");
console.log("─".repeat(78));
const byResource = new Map<string, { read: number; write: number; irreversible: number; del: number }>();
for (const t of tools) {
  const key = t.operation ? (t.operation.path.split("/")[1] ?? "?") : "(hand-written)";
  const row = byResource.get(key) ?? { read: 0, write: 0, irreversible: 0, del: 0 };
  const c = t.category.category;
  if (c === "read" || c === "read-pdf" || c === "preview") row.read++;
  else if (c === "destructive") row.del++;
  else if (c === "irreversible-external" || c === "irreversible-ledger") row.irreversible++;
  else row.write++;
  byResource.set(key, row);
}
for (const [res, row] of [...byResource.entries()].sort()) {
  const total = row.read + row.write + row.irreversible + row.del;
  console.log(
    `  ${res.padEnd(30)} ${pad(total, 3)}  │ ${pad(row.read, 3)} ${pad(row.write, 3)} ${pad(row.irreversible, 3)} ${pad(row.del, 3)}`,
  );
}
console.log("─".repeat(78));
console.log(`\nWAFEQ_TOOL_GROUPS accepts: ${availableGroups(tools).join(", ")}\n`);

console.log("SAMPLE TOOLS");
for (const cat of CATEGORY_ORDER) {
  const list = byCategory.get(cat);
  if (!list?.length) continue;
  console.log(`\n  ${CATEGORY_LABEL[cat]}:`);
  for (const t of list.slice(0, 3)) {
    console.log(`    ${t.category.icon}  ${t.name.padEnd(50)} ${t.annotations.title ?? ""}`);
  }
  if (list.length > 3) console.log(`    …and ${list.length - 3} more`);
}

// Invariants worth failing CI over.
const problems: string[] = [];
const seen = new Set<string>();
for (const t of tools) {
  if (seen.has(t.name)) problems.push(`duplicate tool name: ${t.name}`);
  seen.add(t.name);
  if (t.name.length > 64) problems.push(`tool name too long (${t.name.length}): ${t.name}`);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) problems.push(`illegal tool name: ${t.name}`);
  const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  for (const key of Object.keys(props)) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) problems.push(`illegal argument key "${key}" on ${t.name}`);
  }
}

if (problems.length > 0) {
  console.error(`\n❌ ${problems.length} problem(s):`);
  for (const p of problems.slice(0, 20)) console.error(`   - ${p}`);
  process.exit(1);
}
console.log("\n✓ All tool names and argument keys are unique and schema-legal.");
