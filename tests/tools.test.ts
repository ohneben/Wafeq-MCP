import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadOpenApi } from "../src/openapi.js";
import { availableGroups, filterToolsByGroup, operationsToTools } from "../src/tools.js";

const { operations } = loadOpenApi(resolve(__dirname, "..", "spec", "wafeq-public-api.json"));
const tools = operationsToTools(operations);
const byName = new Map(tools.map((t) => [t.name, t]));
const props = (name: string) =>
  (byName.get(name)!.inputSchema as { properties: Record<string, any> }).properties;
const required = (name: string) => (byName.get(name)!.inputSchema as { required?: string[] }).required ?? [];

describe("tool generation", () => {
  it("produces one tool per operation with a unique, legal name", () => {
    expect(tools.length).toBe(operations.length);
    const names = new Set(tools.map((t) => t.name));
    expect(names.size).toBe(tools.length);
    for (const t of tools) {
      expect(t.name.length, t.name).toBeLessThanOrEqual(64);
      expect(/^[a-zA-Z0-9_-]+$/.test(t.name), t.name).toBe(true);
      expect(t.name.startsWith("wafeq_"), t.name).toBe(true);
    }
  });

  it("uses schema-legal argument keys throughout", () => {
    for (const t of tools) {
      for (const key of Object.keys((t.inputSchema as any).properties ?? {})) {
        expect(/^[a-zA-Z0-9_.-]{1,64}$/.test(key), `${t.name}.${key}`).toBe(true);
      }
    }
  });

  it("opens every description with a safety banner", () => {
    for (const t of tools) {
      expect(t.description.startsWith(t.category.banner), t.name).toBe(true);
    }
  });

  it("marks every required property as an actual property", () => {
    for (const t of tools) {
      const schema = t.inputSchema as { required?: string[]; properties: Record<string, unknown> };
      for (const r of schema.required ?? []) expect(schema.properties[r], `${t.name}.${r}`).toBeDefined();
    }
  });
});

describe("report tools — the parameter defect", () => {
  it("never offers date_from/date_to on any tool", () => {
    // The old connector exposed these on every report. Wafeq accepts neither, and
    // silently ignores unknown query params rather than erroring.
    for (const t of tools) {
      const keys = Object.keys((t.inputSchema as any).properties ?? {});
      expect(keys, t.name).not.toContain("date_from");
      expect(keys, t.name).not.toContain("date_to");
    }
  });

  it("gives balance sheet `date` + `period_count`, both required", () => {
    const p = props("wafeq_reports_balance_sheet_list");
    expect(Object.keys(p)).toEqual(
      expect.arrayContaining(["date", "period_count", "group_by", "currency"]),
    );
    expect(required("wafeq_reports_balance_sheet_list")).toEqual(
      expect.arrayContaining(["date", "period_count"]),
    );
    expect(Object.keys(p)).not.toContain("date_after");
  });

  it("gives profit-and-loss and cash-flow `date_after` + `date_before`, both required", () => {
    for (const name of ["wafeq_reports_profit_and_loss_list", "wafeq_reports_cash_flow_list"]) {
      expect(Object.keys(props(name)), name).toEqual(
        expect.arrayContaining(["date_after", "date_before", "group_by"]),
      );
      expect(required(name), name).toEqual(expect.arrayContaining(["date_after", "date_before"]));
      expect(Object.keys(props(name)), name).not.toContain("date");
    }
  });

  it("gives trial balance `from_date` + `to_date`", () => {
    const p = props("wafeq_reports_trial_balance_list");
    expect(Object.keys(p)).toEqual(
      expect.arrayContaining(["from_date", "to_date", "with_pnl_openings", "include_zero_balances"]),
    );
    expect(Object.keys(p)).not.toContain("date_after");
  });

  it("documents the whole-period rule where it applies", () => {
    expect(byName.get("wafeq_reports_profit_and_loss_list")!.description).toContain("group_by=year");
    expect(byName.get("wafeq_reports_trial_balance_list")!.description).toContain("from_date");
  });

  it("has one tool per report rather than one shared tool", () => {
    const reportTools = tools.filter((t) => t.operation!.path.startsWith("/reports/"));
    expect(reportTools.length).toBe(4);
  });
});

describe("idempotency", () => {
  it("offers idempotency_key on writes that support it, never on reads", () => {
    expect(Object.keys(props("wafeq_invoices_create"))).toContain("idempotency_key");
    expect(Object.keys(props("wafeq_invoices_destroy"))).toContain("idempotency_key");
    expect(Object.keys(props("wafeq_invoices_list"))).not.toContain("idempotency_key");
  });

  it("never exposes the raw header name as an argument", () => {
    for (const t of tools) {
      const keys = Object.keys((t.inputSchema as any).properties ?? {});
      expect(keys.map((k) => k.toLowerCase()), t.name).not.toContain("x-wafeq-idempotency-key");
    }
  });

  it("covers every write endpoint Wafeq exposes the header on", () => {
    const writes = tools.filter((t) => t.operation!.method !== "get");
    const withKey = writes.filter((t) => Object.keys((t.inputSchema as any).properties).includes("idempotency_key"));
    expect(withKey.length).toBe(146);
  });
});

describe("file upload tools", () => {
  it("exposes file arguments instead of an unusable JSON body", () => {
    for (const name of ["wafeq_upload_file", "wafeq_upload_file_raw"]) {
      const p = props(name);
      expect(Object.keys(p), name).toEqual(
        expect.arrayContaining(["file_base64", "file_path", "filename", "content_type"]),
      );
      expect(required(name), name).toContain("filename");
      expect(Object.keys(p), name).not.toContain("body");
    }
  });

  it("does not make the caller set Content-Disposition by hand", () => {
    expect(Object.keys(props("wafeq_upload_file_raw")).map((k) => k.toLowerCase())).not.toContain(
      "content-disposition",
    );
  });
});

describe("group filtering", () => {
  it("narrows the catalogue and is case-insensitive", () => {
    const filtered = filterToolsByGroup(tools, ["Invoices", "reports"]);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(tools.length);
    expect(filtered.every((t) => /^\/(invoices|reports)\//.test(t.operation!.path))).toBe(true);
  });

  it("returns everything when no groups are given", () => {
    expect(filterToolsByGroup(tools, []).length).toBe(tools.length);
  });

  it("lists the groups it accepts", () => {
    const groups = availableGroups(tools);
    expect(groups).toContain("invoices");
    expect(groups).toContain("journal_line_items");
    expect(groups.length).toBe(32);
  });
});
