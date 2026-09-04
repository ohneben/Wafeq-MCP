import { callRaw, type CallResult, type WafeqConfig } from "./client.js";
import type { CategoryInfo } from "./categorize.js";
import { lastDayOfMonth } from "./overrides.js";
import type { HandlerResult, ToolDefinition } from "./tools.js";
import { TOOL_PREFIX } from "./tools.js";

/** Default ceiling on the window `wafeq_account_ledger` will resolve dates for. */
export const LEDGER_MAX_DAYS = 92;
/** Default ceiling on rows returned, so a wide query can't flood the context. */
export const LEDGER_MAX_ROWS = 2000;

const PASSTHROUGH_CATEGORY: CategoryInfo = {
  category: "destructive",
  banner: "🔴 DESTRUCTIVE · arbitrary API call",
  icon: "🔴",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
};

const LEDGER_CATEGORY: CategoryInfo = {
  category: "read",
  banner: "🟢 READ-ONLY",
  icon: "🟢",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000) + 1;
}

/** Split an inclusive range into whole-month chunks clipped to the range. */
export function monthChunks(after: string, before: string): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  const end = toUtc(before);
  let cursor = toUtc(after);
  while (cursor.getTime() <= end.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const monthEnd = toUtc(`${y}-${String(m).padStart(2, "0")}-${String(lastDayOfMonth(y, m)).padStart(2, "0")}`);
    const chunkEnd = monthEnd.getTime() < end.getTime() ? monthEnd : end;
    chunks.push({ start: fmt(cursor), end: fmt(chunkEnd) });
    cursor = new Date(chunkEnd.getTime() + 86_400_000);
  }
  return chunks;
}

export function eachDay(after: string, before: string): string[] {
  const out: string[] = [];
  const end = toUtc(before).getTime();
  for (let t = toUtc(after).getTime(); t <= end; t += 86_400_000) out.push(fmt(new Date(t)));
  return out;
}

interface LedgerRow extends Record<string, unknown> {
  id?: string;
}

/** Page through `/journal-line-items/` (cursor-paginated) for one window. */
async function fetchWindow(
  cfg: WafeqConfig,
  query: Record<string, unknown>,
  maxRows: number,
  counter: { requests: number },
): Promise<{ rows: LedgerRow[]; truncated: boolean }> {
  const rows: LedgerRow[] = [];
  let next: string | undefined;
  let truncated = false;

  for (;;) {
    counter.requests++;
    const res: CallResult = next
      ? await callRaw(cfg, { method: "GET", path: next })
      : await callRaw(cfg, { method: "GET", path: "/journal-line-items/", query });

    if (!res.ok) {
      const detail = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      throw new Error(`journal-line-items returned HTTP ${res.status}: ${detail}`);
    }

    const body = res.body as { results?: LedgerRow[]; next?: string | null };
    for (const row of body.results ?? []) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    if (truncated || !body.next) break;
    next = body.next;
  }

  return { rows, truncated };
}

/**
 * Journal line items carry `created_ts` (when the row reached Wafeq) but no
 * transaction date — a January transaction routinely shows a February
 * `created_ts` — so a model reading the raw endpoint will misdate the ledger.
 *
 * The list endpoint's `date_after`/`date_before` filters DO operate on the real
 * transaction date, so this tool recovers the date from the filter rather than by
 * joining to `/manual-journals/`. Joining would only work for journals that came
 * from a manual journal in the first place; most come from invoices, bills and
 * payments, and would be left dateless.
 *
 * Cost is kept down by probing a whole month first and only splitting into days
 * when that month actually has rows, so quiet periods cost one request each.
 */
async function accountLedger(cfg: WafeqConfig, args: Record<string, unknown>): Promise<HandlerResult> {
  const after = String(args.date_after ?? "").trim();
  const before = String(args.date_before ?? "").trim();
  if (!ISO_DATE.test(after) || !ISO_DATE.test(before)) {
    throw new Error("`date_after` and `date_before` are required, in YYYY-MM-DD format.");
  }
  if (toUtc(after).getTime() > toUtc(before).getTime()) {
    throw new Error("`date_after` must be on or before `date_before`.");
  }

  const span = daysBetween(after, before);
  const maxRows = Math.max(1, Number(args.max_rows ?? LEDGER_MAX_ROWS));
  const resolveDates = args.resolve_dates !== false;

  const baseQuery: Record<string, unknown> = { page_size: 100 };
  for (const key of ["account", "contact", "project", "cost_center", "branch", "currency", "journal", "tax_rate"]) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== "") baseQuery[key] = args[key];
  }

  const counter = { requests: 0 };
  const notes: string[] = [];

  const asResult = (payload: unknown): HandlerResult => ({ text: JSON.stringify(payload, null, 2) });

  if (!resolveDates || span > LEDGER_MAX_DAYS) {
    if (resolveDates && span > LEDGER_MAX_DAYS) {
      notes.push(
        `Range is ${span} days, over the ${LEDGER_MAX_DAYS}-day limit for date resolution, so rows are returned ` +
          `without a transaction date. Narrow the range to get dates, and remember that created_ts is NOT the ` +
          `transaction date.`,
      );
    }
    const { rows, truncated } = await fetchWindow(
      cfg,
      { ...baseQuery, date_after: after, date_before: before },
      maxRows,
      counter,
    );
    return asResult({
      date_after: after,
      date_before: before,
      dates_resolved: false,
      row_count: rows.length,
      truncated,
      requests_made: counter.requests,
      notes,
      rows,
    });
  }

  const dated: LedgerRow[] = [];
  let truncated = false;

  for (const chunk of monthChunks(after, before)) {
    const probe = await fetchWindow(cfg, { ...baseQuery, date_after: chunk.start, date_before: chunk.end }, maxRows, counter);
    if (probe.rows.length === 0) continue; // Quiet month: one request, no day queries.

    for (const day of eachDay(chunk.start, chunk.end)) {
      if (dated.length >= maxRows) {
        truncated = true;
        break;
      }
      const perDay = await fetchWindow(
        cfg,
        { ...baseQuery, date_after: day, date_before: day },
        maxRows - dated.length,
        counter,
      );
      for (const row of perDay.rows) dated.push({ date: day, ...row });
      if (perDay.truncated) truncated = true;
    }
    if (truncated) break;
  }

  notes.push("`date` is the transaction date, recovered via Wafeq's date filter. `created_ts` is when the row reached Wafeq and is often a different month.");

  return asResult({
    date_after: after,
    date_before: before,
    dates_resolved: true,
    row_count: dated.length,
    truncated,
    requests_made: counter.requests,
    notes,
    rows: dated,
  });
}

export function extraTools(cfg: WafeqConfig): ToolDefinition[] {
  return [
    {
      name: `${TOOL_PREFIX}account_ledger`,
      description: [
        `${LEDGER_CATEGORY.banner} · Journal Line Items · convenience tool`,
        "List journal line items WITH their real transaction date attached as `date`.",
        "Use this instead of the raw journal-line-items tool whenever the date matters — for tracing an account's " +
          "history, reconciling a period, or explaining a balance. The raw endpoint returns `created_ts` (when the row " +
          "reached Wafeq), which is regularly a different month from the transaction and must not be reported as the " +
          "transaction date.",
        `Both dates are required and the window must be ${LEDGER_MAX_DAYS} days or fewer for dates to be resolved; ` +
          "a wider range still returns rows, but without `date`. Costs one request per month plus one per day in " +
          "months that contain rows, so quiet periods are cheap. The result reports `requests_made`.",
      ].join("\n\n"),
      inputSchema: {
        type: "object",
        properties: {
          date_after: { type: "string", description: "Start of the range, inclusive (YYYY-MM-DD). Required." },
          date_before: { type: "string", description: "End of the range, inclusive (YYYY-MM-DD). Required." },
          account: { type: "string", description: "Account id to filter by, e.g. \"acc_2SrR5fcutXPNtgrrwPmrUU\"." },
          contact: { type: "string", description: "Contact id to filter by." },
          project: { type: "string", description: "Project id to filter by." },
          cost_center: { type: "string", description: "Cost center id to filter by." },
          branch: { type: "string", description: "Branch id to filter by." },
          currency: { type: "string", description: "Currency code to filter by, e.g. \"EUR\"." },
          journal: { type: "string", description: "Journal id to filter by." },
          tax_rate: { type: "string", description: "Tax rate id to filter by." },
          max_rows: {
            type: "integer",
            description: `Stop after this many rows (default ${LEDGER_MAX_ROWS}).`,
            minimum: 1,
          },
          resolve_dates: {
            type: "boolean",
            description:
              "Set false to skip date resolution and fetch the whole range in one pass — faster, but rows come back without `date`. Default true.",
          },
        },
        required: ["date_after", "date_before"],
        additionalProperties: false,
      },
      annotations: {
        title: "Account ledger (journal lines with dates)",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      category: LEDGER_CATEGORY,
      handler: (args) => accountLedger(cfg, args),
    },
    {
      name: `${TOOL_PREFIX}request`,
      description: [
        `${PASSTHROUGH_CATEGORY.banner} · Escape hatch · any method, any path`,
        "Call any Wafeq endpoint directly, with full control over method, path, query, body AND headers.",
        "This is the FALLBACK, not the primary interface: every documented endpoint already has its own generated tool " +
          "with a correct input schema and an accurate safety category. Reach for this only for something the bundled " +
          "spec does not cover.",
        "It is categorized destructive because the effect cannot be known in advance — the same tool can read a report " +
          "or delete an invoice. Confirm with the user before any non-GET call.",
        "Writes get an automatic X-Wafeq-Idempotency-Key unless you supply one in `headers`. `Authorization` is always " +
          "set from the server's own credentials and cannot be overridden.",
      ].join("\n\n"),
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
            description: "HTTP method.",
          },
          path: {
            type: "string",
            description: "Path relative to the API base, e.g. \"/invoices/\" or \"/invoices/inv_123/\".",
          },
          query: { type: "object", description: "Query parameters as a JSON object. Array values repeat the key." },
          body: { type: "object", description: "JSON request body, for POST/PUT/PATCH." },
          headers: {
            type: "object",
            description:
              "Extra request headers, e.g. {\"X-Wafeq-Idempotency-Key\": \"...\"}. Authorization is ignored here.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["method", "path"],
        additionalProperties: false,
      },
      annotations: {
        title: "Wafeq API request (advanced)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      category: PASSTHROUGH_CATEGORY,
      handler: async (args) => {
        const res = await callRaw(cfg, {
          method: String(args.method ?? "GET"),
          path: String(args.path ?? "/"),
          query: (args.query ?? undefined) as Record<string, unknown> | undefined,
          body: args.body,
          headers: (args.headers ?? undefined) as Record<string, string> | undefined,
        });
        const body = typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2);
        // Same shape the generated tools produce, so the model reads one format.
        return { isError: !res.ok, text: `HTTP ${res.status} ${res.ok ? "OK" : "ERROR"}\n${body}` };
      },
    },
  ];
}
