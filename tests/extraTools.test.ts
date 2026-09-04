import { describe, expect, it, vi } from "vitest";
import type { WafeqConfig } from "../src/client.js";
import { eachDay, extraTools, monthChunks } from "../src/extraTools.js";

describe("date helpers", () => {
  it("splits a range into whole months clipped to the range", () => {
    expect(monthChunks("2026-01-15", "2026-03-04")).toEqual([
      { start: "2026-01-15", end: "2026-01-31" },
      { start: "2026-02-01", end: "2026-02-28" },
      { start: "2026-03-01", end: "2026-03-04" },
    ]);
  });

  it("handles a single-day range and a leap February", () => {
    expect(monthChunks("2026-05-04", "2026-05-04")).toEqual([{ start: "2026-05-04", end: "2026-05-04" }]);
    expect(monthChunks("2024-02-01", "2024-02-29")).toEqual([{ start: "2024-02-01", end: "2024-02-29" }]);
  });

  it("enumerates days inclusively", () => {
    expect(eachDay("2026-01-30", "2026-02-02")).toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  });
});

/**
 * A stand-in for /journal-line-items/ that honours date_after/date_before the way
 * the real endpoint does, so the ledger tool's date recovery can be checked.
 */
function fakeWafeq(rows: Array<{ id: string; date: string }>) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const after = u.searchParams.get("date_after")!;
    const before = u.searchParams.get("date_before")!;
    const matched = rows.filter((r) => r.date >= after && r.date <= before);
    return new Response(
      JSON.stringify({
        next: null,
        previous: null,
        results: matched.map((r) => ({ id: r.id, account: "acc_1", created_ts: "2026-12-31T00:00:00Z" })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { impl, calls };
}

function cfgWith(fetchImpl: typeof fetch): WafeqConfig {
  return {
    baseUrl: "https://api.wafeq.com/v1",
    apiToken: "k",
    authScheme: "api-key",
    fetchImpl,
    maxRetries: 0,
    timeoutMs: 2000,
  };
}

const ledgerTool = (cfg: WafeqConfig) => extraTools(cfg).find((t) => t.name === "wafeq_account_ledger")!;
/** Handlers return { text }, so unwrap the JSON payload for assertions. */
const runLedger = async (cfg: WafeqConfig, args: Record<string, unknown>) =>
  JSON.parse((await ledgerTool(cfg).handler!(args)).text);
const requestTool = (cfg: WafeqConfig) => extraTools(cfg).find((t) => t.name === "wafeq_request")!;

describe("wafeq_account_ledger", () => {
  it("attaches the real transaction date to every row", async () => {
    const { impl } = fakeWafeq([
      { id: "a", date: "2026-01-05" },
      { id: "b", date: "2026-01-05" },
      { id: "c", date: "2026-01-20" },
    ]);
    const res = await runLedger(cfgWith(impl as unknown as typeof fetch), {
      date_after: "2026-01-01",
      date_before: "2026-01-31",
      account: "acc_1",
    });

    expect(res.dates_resolved).toBe(true);
    expect(res.row_count).toBe(3);
    expect(res.rows.map((r: any) => [r.id, r.date])).toEqual([
      ["a", "2026-01-05"],
      ["b", "2026-01-05"],
      ["c", "2026-01-20"],
    ]);
    // created_ts is still present but is explicitly not the transaction date.
    expect(res.rows[0].created_ts).toBe("2026-12-31T00:00:00Z");
    expect(res.notes.join(" ")).toContain("created_ts");
  });

  it("skips day queries for months with no rows", async () => {
    const { impl, calls } = fakeWafeq([{ id: "a", date: "2026-03-10" }]);
    const res = await runLedger(cfgWith(impl as unknown as typeof fetch), {
      date_after: "2026-01-01",
      date_before: "2026-03-31",
    });

    expect(res.row_count).toBe(1);
    // 3 month probes + 31 day queries for March only; Jan and Feb cost one each.
    expect(res.requests_made).toBe(3 + 31);
    expect(calls.some((c) => c.includes("date_after=2026-02-01&date_before=2026-02-28"))).toBe(true);
    expect(calls.some((c) => c.includes("date_after=2026-02-14&date_before=2026-02-14"))).toBe(false);
  });

  it("returns rows without dates when the range is too wide, and says so", async () => {
    const { impl } = fakeWafeq([{ id: "a", date: "2026-03-10" }]);
    const res = await runLedger(cfgWith(impl as unknown as typeof fetch), {
      date_after: "2026-01-01",
      date_before: "2026-12-31",
    });

    expect(res.dates_resolved).toBe(false);
    expect(res.requests_made).toBe(1);
    expect(res.notes.join(" ")).toContain("over the 92-day limit");
    expect(res.rows[0].date).toBeUndefined();
  });

  it("honours resolve_dates=false as a fast single pass", async () => {
    const { impl } = fakeWafeq([{ id: "a", date: "2026-01-05" }]);
    const res = await runLedger(cfgWith(impl as unknown as typeof fetch), {
      date_after: "2026-01-01",
      date_before: "2026-01-31",
      resolve_dates: false,
    });
    expect(res.requests_made).toBe(1);
    expect(res.dates_resolved).toBe(false);
  });

  it("follows cursor pagination", async () => {
    let page = 0;
    const impl = vi.fn(async () => {
      page++;
      return new Response(
        JSON.stringify({
          next: page === 1 ? "https://api.wafeq.com/v1/journal-line-items/?cursor=abc" : null,
          results: [{ id: `row${page}` }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const res = await runLedger(cfgWith(impl as unknown as typeof fetch), {
      date_after: "2026-01-01",
      date_before: "2026-01-01",
      // Single pass, so the two pages assert paging alone rather than the
      // month-probe-then-day-query sequence.
      resolve_dates: false,
    });
    expect(res.rows.map((r: any) => r.id)).toEqual(["row1", "row2"]);
  });

  it("caps the number of rows returned", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, date: "2026-01-05" }));
    const { impl } = fakeWafeq(rows);
    const res = await runLedger(cfgWith(impl as unknown as typeof fetch), {
      date_after: "2026-01-01",
      date_before: "2026-01-31",
      max_rows: 10,
    });
    expect(res.row_count).toBe(10);
    expect(res.truncated).toBe(true);
  });

  it("rejects a malformed or backwards range", async () => {
    const { impl } = fakeWafeq([]);
    const tool = ledgerTool(cfgWith(impl as unknown as typeof fetch));
    await expect(tool.handler!({ date_after: "nope", date_before: "2026-01-31" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(tool.handler!({ date_after: "2026-02-01", date_before: "2026-01-01" })).rejects.toThrow(
      /on or before/,
    );
  });
});

describe("wafeq_request passthrough", () => {
  it("is categorized destructive and accepts headers", () => {
    const { impl } = fakeWafeq([]);
    const tool = requestTool(cfgWith(impl as unknown as typeof fetch));
    expect(tool.annotations.destructiveHint).toBe(true);
    expect(tool.annotations.readOnlyHint).toBe(false);
    const props = (tool.inputSchema as any).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["method", "path", "query", "body", "headers"]));
  });
});

describe("wafeq_request error reporting", () => {
  it("reports a non-2xx response as a tool error, not as a successful result", async () => {
    const impl = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    const res = await requestTool(cfgWith(impl as unknown as typeof fetch)).handler!({
      method: "GET",
      path: "/nope/",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("HTTP 404 ERROR");
    expect(res.text).toContain("Not found");
  });

  it("reports a 2xx response as success in the same shape as a generated tool", async () => {
    const impl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await requestTool(cfgWith(impl as unknown as typeof fetch)).handler!({
      method: "GET",
      path: "/tax-rates/",
    });
    expect(res.isError).toBe(false);
    expect(res.text.startsWith("HTTP 200 OK\n")).toBe(true);
  });
});
