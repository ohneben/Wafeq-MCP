/**
 * Corrections and caveats keyed by `operationId`.
 *
 * Everything here comes from behaviour observed against the live API, not from the
 * spec. Each entry says what was observed and when, so that when a future spec drop
 * makes one obsolete it can be deleted with confidence. Keying by `operationId`
 * (rather than by array index or path) keeps the drop-in-a-newer-spec property: an
 * entry whose operation disappears simply stops applying.
 *
 * Verified 2026-09-04 against api.wafeq.com/v1 using read-only requests.
 */

export interface PeriodRule {
  /** Query params holding the inclusive range start and end. */
  startParam: string;
  endParam: string;
  /** Query param selecting the period size. */
  groupByParam: string;
  defaultGroupBy: "month" | "year";
}

/**
 * Reports whose date range must align to whole periods.
 *
 * Observed: `GET /reports/profit-and-loss/?date_after=2026-01-01&date_before=2026-08-31&group_by=year`
 * returns HTTP 400 "make sure that `date_after` and `date_before` are the first and
 * last day of the year respectively." The same range with `group_by=month` succeeds,
 * but `date_after=2026-01-15` with `group_by=month` returns the month-flavoured
 * version of the same 400. So the rule is not "no partial years" — it is "the range
 * must start on the first day and end on the last day of a whole period", for both
 * period sizes. That is checkable locally, so {@link checkPeriodAlignment} rejects
 * it with a corrected range instead of spending a round trip on a 400.
 */
export const PERIOD_RULES: Record<string, PeriodRule> = {
  reports_profit_and_loss_list: {
    startParam: "date_after",
    endParam: "date_before",
    groupByParam: "group_by",
    defaultGroupBy: "month",
  },
  reports_cash_flow_list: {
    startParam: "date_after",
    endParam: "date_before",
    groupByParam: "group_by",
    defaultGroupBy: "month",
  },
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Last calendar day of the month containing `year`/`month` (1-indexed month). */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseDate(value: unknown): { y: number; m: number; d: number } | undefined {
  if (typeof value !== "string") return undefined;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return undefined;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/**
 * Return a human-readable error when a report range does not align to whole
 * periods, or `undefined` when it is fine (or not checkable). The message names the
 * nearest valid range so the model can retry correctly on the first attempt.
 */
export function checkPeriodAlignment(
  operationId: string,
  args: Record<string, unknown>,
): string | undefined {
  const rule = PERIOD_RULES[operationId];
  if (!rule) return undefined;

  const start = parseDate(args[rule.startParam]);
  const end = parseDate(args[rule.endParam]);
  if (!start || !end) return undefined; // Missing/malformed dates: let the API answer.

  const groupByRaw = args[rule.groupByParam];
  const groupBy = groupByRaw === "year" || groupByRaw === "month" ? groupByRaw : rule.defaultGroupBy;

  const pad = (n: number) => String(n).padStart(2, "0");

  if (groupBy === "year") {
    const startOk = start.m === 1 && start.d === 1;
    const endOk = end.m === 12 && end.d === 31;
    if (startOk && endOk) return undefined;
    return (
      `Invalid date range for group_by=year: Wafeq requires ${rule.startParam} to be 1 January and ` +
      `${rule.endParam} to be 31 December. You passed ${rule.startParam}=${args[rule.startParam]}, ` +
      `${rule.endParam}=${args[rule.endParam]}. Either use ${rule.startParam}=${start.y}-01-01 and ` +
      `${rule.endParam}=${end.y}-12-31, or keep your dates and switch to group_by=month ` +
      `(which accepts any whole-month range).`
    );
  }

  const startOk = start.d === 1;
  const endOk = end.d === lastDayOfMonth(end.y, end.m);
  if (startOk && endOk) return undefined;
  return (
    `Invalid date range for group_by=month: Wafeq requires ${rule.startParam} to be the first day of a ` +
    `month and ${rule.endParam} to be the last day of a month. You passed ` +
    `${rule.startParam}=${args[rule.startParam]}, ${rule.endParam}=${args[rule.endParam]}. ` +
    `The nearest valid range is ${rule.startParam}=${start.y}-${pad(start.m)}-01 and ` +
    `${rule.endParam}=${end.y}-${pad(end.m)}-${pad(lastDayOfMonth(end.y, end.m))}.`
  );
}

/**
 * Extra guidance appended to a tool's description, keyed by `operationId`.
 * Kept short: these are read by the model on every tool list.
 */
export const OPERATION_NOTES: Record<string, string> = {
  reports_balance_sheet_list:
    "PARAMETERS: this report takes `date` (the 'as of' date) and `period_count` (0-11 extra comparison periods) — both REQUIRED. " +
    "It does NOT take a date range; there is no `date_from`/`date_to`/`date_after`/`date_before`. " +
    "`group_by` (month|year) sets the size of the comparison periods.",

  reports_profit_and_loss_list:
    "PARAMETERS: `date_after` and `date_before` are both REQUIRED and are the range bounds. There is no `date_from`/`date_to`. " +
    "The range must cover whole periods: with `group_by=month` (the default) it must run from the first day of a month to the " +
    "last day of a month; with `group_by=year` it must run 1 January to 31 December. A partial year with `group_by=year` is " +
    "rejected — use `group_by=month` for a year-to-date figure. This server checks the range before sending and tells you the " +
    "nearest valid one.",

  reports_cash_flow_list:
    "PARAMETERS: `date_after` and `date_before` are both REQUIRED and are the range bounds. There is no `date_from`/`date_to`. " +
    "The same whole-period rule as profit-and-loss applies and is checked before sending.",

  reports_trial_balance_list:
    "PARAMETERS: this report uses `from_date` and `to_date` (NOT `date_after`/`date_before`, and NOT `date_from`/`date_to`). " +
    "Both are optional; omitting them returns the current financial year. Verified 2026-09-04: the dates ARE honoured when " +
    "spelled correctly — a narrower range returns a smaller report. Wafeq silently ignores misspelled query parameters rather " +
    "than erroring, so a wrong name looks like a working call that returns the default period.",

  journal_line_items_list:
    "NO DATE FIELD: rows carry `created_ts` (when the row was written to Wafeq) and `modified_ts`, but NOT the transaction date. " +
    "`created_ts` is frequently a different month from the transaction — do not report it as the transaction date. " +
    "To work by transaction date, filter with `date_after`/`date_before`, which DO operate on the real transaction date. " +
    "For rows that come back already carrying their date, use the `wafeq_account_ledger` tool instead. " +
    "Note this endpoint is cursor-paginated (`cursor` + `page_size`), unlike the rest of the API, which uses `page`.",

  journal_line_items_retrieve:
    "NO DATE FIELD: the row carries `created_ts` (when it was written to Wafeq), which is not the transaction date. " +
    "The transaction date lives on the parent journal referenced by the `journal` field.",

  upload_file:
    "Send the file with `file_base64` plus `filename` (and optionally `content_type`); this server builds the multipart/form-data " +
    "body for you. For a file already on the machine running this server, pass `file_path` instead.",

  upload_file_raw:
    "Advanced upload: sends the bytes as the raw request body with a `Content-Disposition` header. Prefer `upload_file` unless you " +
    "specifically need raw mode. Provide `file_base64` + `filename`, or `file_path`.",

  expenses_mark_as_posted_create:
    "Generates the expense's journal and posts it to the ledger. Undo with `mark expense as draft`.",

  expenses_mark_as_draft_create:
    "Removes the expense's journal from the ledger and returns it to draft. Undo with `mark expense as posted`.",

  quotes_invoice_create:
    "Creates a NEW invoice from the quote. Calling twice creates two invoices — pass an `idempotency_key` if you may retry.",

  purchase_orders_bill_create:
    "Creates a NEW draft bill from the purchase order. Calling twice creates two bills — pass an `idempotency_key` if you may retry.",
};
