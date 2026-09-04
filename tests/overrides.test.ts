import { describe, expect, it } from "vitest";
import { checkPeriodAlignment, lastDayOfMonth, OPERATION_NOTES } from "../src/overrides.js";

const PNL = "reports_profit_and_loss_list";

describe("checkPeriodAlignment", () => {
  it("accepts a whole-month range with the default grouping", () => {
    expect(checkPeriodAlignment(PNL, { date_after: "2026-01-01", date_before: "2026-08-31" })).toBeUndefined();
  });

  it("accepts a whole-year range with group_by=year", () => {
    expect(
      checkPeriodAlignment(PNL, { date_after: "2026-01-01", date_before: "2026-12-31", group_by: "year" }),
    ).toBeUndefined();
  });

  it("rejects a partial year with group_by=year and names the fix", () => {
    // Observed live: HTTP 400 "first and last day of the year respectively".
    const err = checkPeriodAlignment(PNL, {
      date_after: "2026-01-01",
      date_before: "2026-08-31",
      group_by: "year",
    });
    expect(err).toContain("group_by=year");
    expect(err).toContain("2026-12-31");
    expect(err).toContain("group_by=month");
  });

  it("rejects a mid-month start even with group_by=month", () => {
    // Observed live: the same 400, month-flavoured — the rule is whole periods,
    // not merely whole years.
    const err = checkPeriodAlignment(PNL, { date_after: "2026-01-15", date_before: "2026-08-31" });
    expect(err).toContain("first day of a month");
    expect(err).toContain("2026-01-01");
  });

  it("rejects an end date that is not the last day of its month", () => {
    const err = checkPeriodAlignment(PNL, { date_after: "2026-01-01", date_before: "2026-08-30" });
    expect(err).toContain("2026-08-31");
  });

  it("handles February in a leap year", () => {
    expect(lastDayOfMonth(2024, 2)).toBe(29);
    expect(lastDayOfMonth(2026, 2)).toBe(28);
    expect(checkPeriodAlignment(PNL, { date_after: "2024-02-01", date_before: "2024-02-29" })).toBeUndefined();
    expect(checkPeriodAlignment(PNL, { date_after: "2024-02-01", date_before: "2024-02-28" })).toContain("2024-02-29");
  });

  it("applies to cash flow as well as profit and loss", () => {
    expect(
      checkPeriodAlignment("reports_cash_flow_list", { date_after: "2026-01-15", date_before: "2026-08-31" }),
    ).toContain("first day of a month");
  });

  it("stays out of the way for reports without the rule", () => {
    expect(checkPeriodAlignment("reports_balance_sheet_list", { date: "2026-08-31" })).toBeUndefined();
    expect(
      checkPeriodAlignment("reports_trial_balance_list", { from_date: "2026-01-15", to_date: "2026-08-20" }),
    ).toBeUndefined();
  });

  it("defers to the API when dates are missing or malformed", () => {
    expect(checkPeriodAlignment(PNL, {})).toBeUndefined();
    expect(checkPeriodAlignment(PNL, { date_after: "nonsense", date_before: "2026-08-31" })).toBeUndefined();
  });
});

describe("operation notes", () => {
  it("warns that created_ts is not the transaction date", () => {
    expect(OPERATION_NOTES.journal_line_items_list).toContain("NOT the transaction date");
    expect(OPERATION_NOTES.journal_line_items_list).toContain("date_after");
  });

  it("spells out the correct parameters for every report", () => {
    expect(OPERATION_NOTES.reports_balance_sheet_list).toContain("period_count");
    expect(OPERATION_NOTES.reports_trial_balance_list).toContain("from_date");
    expect(OPERATION_NOTES.reports_profit_and_loss_list).toContain("date_after");
  });
});
