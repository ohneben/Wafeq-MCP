import type { Operation } from "./openapi.js";

/**
 * Safety categories.
 *
 * The four CRUD buckets (read / create / update / destroy) do not describe Wafeq
 * honestly: a dozen of its POSTs are not creates. Some write nothing at all
 * (`/preview/`), some file a document with a national tax authority and can never
 * be recalled, some post a remaining balance to the ledger with no API undo. Those
 * are separated out so a host can auto-trust the harmless ones and stop on the
 * ones that leave the building.
 */
export type Category =
  | "read"
  | "read-pdf"
  | "preview"
  | "create"
  | "update"
  | "state-change"
  | "irreversible-external"
  | "irreversible-ledger"
  | "destructive";

export interface CategoryInfo {
  category: Category;
  /** Leading line of the tool description. */
  banner: string;
  /** Traffic light for the `list-tools` catalogue. */
  icon: "🟢" | "🟡" | "🟠" | "🔴";
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** Extra sentence appended to the description, where the risk needs spelling out. */
  note?: string;
}

const INFO: Record<Category, Omit<CategoryInfo, "category">> = {
  read: {
    banner: "🟢 READ-ONLY",
    icon: "🟢",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  "read-pdf": {
    banner: "🟢 READ-ONLY · returns a PDF",
    icon: "🟢",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    note: "Returns the document as base64-encoded PDF bytes plus its size and content type. Nothing is modified.",
  },
  preview: {
    banner: "🟢 READ-ONLY · preview / simulation",
    icon: "🟢",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    note: "This is a POST, but Wafeq documents it as a simulation: it returns the events that WOULD be generated and writes nothing to the ledger.",
  },
  create: {
    banner: "🟡 WRITE · creates data",
    icon: "🟡",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    note: "Not idempotent — calling twice creates two records. Pass `idempotency_key` (or let the server generate one) to make a retry safe.",
  },
  update: {
    banner: "🟡 WRITE · updates data",
    icon: "🟡",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  "state-change": {
    banner: "🟠 STATE CHANGE · moves a document in or out of the ledger",
    icon: "🟠",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    note: "Changes posted/draft status, which adds or removes the document's journal from the ledger. Reversible: the opposite tool undoes it.",
  },
  "irreversible-external": {
    banner: "🔴 IRREVERSIBLE · files the document with an external tax authority",
    icon: "🔴",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    note: "Submits the document outside your organization for clearance/reporting. It CANNOT be recalled or undone through this API. Confirm with the user before calling, and check the document's contents first.",
  },
  "irreversible-ledger": {
    banner: "🔴 IRREVERSIBLE · posts the remaining balance to the ledger",
    icon: "🔴",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    note: "Terminates a schedule early and recognizes its whole remaining balance immediately. There is no API undo. Run the matching `preview_...` tool first to see exactly what would be posted.",
  },
  destructive: {
    banner: "🔴 DESTRUCTIVE · deletes",
    icon: "🔴",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    note: "Permanently removes the record.",
  },
};

/**
 * `destructiveHint` is the flag hosts use to demand confirmation, so the two
 * irreversible action groups carry it as well as DELETE. It is set here rather than
 * in {@link INFO} to keep the "what it does" table separate from the "how loudly to
 * warn" decision.
 */
const HINT_DESTRUCTIVE: ReadonlySet<Category> = new Set<Category>([
  "destructive",
  "irreversible-external",
  "irreversible-ledger",
]);

// Path shapes. Matched against the operation path, which always ends in "/".
const PREVIEW = /\/(preview|preview-end-early)\/$/;
const TAX_AUTHORITY_REPORT = /\/tax-authority\/report\/$/;
const END_EARLY = /\/end-early\/$/;
const MARK_AS = /\/mark-as-[a-z-]+\/$/;
/** Document conversions: POST /quotes/{id}/invoice/ and POST /purchase-orders/{id}/bill/. */
const CONVERSION = /\/\{[a-z_]+\}\/(invoice|bill)\/$/;

export function categorize(op: Operation): CategoryInfo {
  const category = classify(op);
  return {
    category,
    ...INFO[category],
    destructiveHint: HINT_DESTRUCTIVE.has(category),
  };
}

function classify(op: Operation): Category {
  if (op.method === "get" || op.method === "head" || op.method === "options") {
    return op.binaryResponseType ? "read-pdf" : "read";
  }
  if (op.method === "delete") return "destructive";
  if (op.method === "put" || op.method === "patch") return "update";

  // Every remaining method is POST. Order matters: the most specific shape wins.
  if (PREVIEW.test(op.path)) return "preview";
  if (TAX_AUTHORITY_REPORT.test(op.path)) return "irreversible-external";
  if (END_EARLY.test(op.path)) return "irreversible-ledger";
  if (MARK_AS.test(op.path)) return "state-change";
  if (CONVERSION.test(op.path)) return "create";
  return "create";
}

/** Stable display order for the catalogue, safest first. */
export const CATEGORY_ORDER: readonly Category[] = [
  "read",
  "read-pdf",
  "preview",
  "create",
  "update",
  "state-change",
  "irreversible-external",
  "irreversible-ledger",
  "destructive",
];

export const CATEGORY_LABEL: Record<Category, string> = {
  read: "Read-only",
  "read-pdf": "Read-only (PDF)",
  preview: "Read-only (preview)",
  create: "Write · creates",
  update: "Write · updates",
  "state-change": "State change",
  "irreversible-external": "Irreversible · external filing",
  "irreversible-ledger": "Irreversible · ledger",
  destructive: "Destructive · deletes",
};
