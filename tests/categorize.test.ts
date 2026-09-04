import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { categorize } from "../src/categorize.js";
import { loadOpenApi, type Operation } from "../src/openapi.js";

const { operations } = loadOpenApi(resolve(__dirname, "..", "spec", "wafeq-public-api.json"));
const byId = new Map(operations.map((o) => [o.operationId, o]));
const cat = (id: string) => categorize(byId.get(id)!).category;

describe("safety categorisation", () => {
  it("classifies plain CRUD by method", () => {
    expect(cat("invoices_list")).toBe("read");
    expect(cat("invoices_create")).toBe("create");
    expect(cat("invoices_update")).toBe("update");
    expect(cat("invoices_partial_update")).toBe("update");
    expect(cat("invoices_destroy")).toBe("destructive");
  });

  it("separates PDF downloads from ordinary reads", () => {
    expect(cat("invoices_download_retrieve")).toBe("read-pdf");
    expect(categorize(byId.get("invoices_download_retrieve")!).readOnlyHint).toBe(true);
  });

  it("treats the four preview POSTs as read-only", () => {
    for (const id of [
      "amortizations_preview_create",
      "amortizations_preview_end_early_create",
      "revenue_recognitions_preview_create",
      "revenue_recognitions_preview_end_early_create",
    ]) {
      expect(cat(id), id).toBe("preview");
      expect(categorize(byId.get(id)!).readOnlyHint, id).toBe(true);
      expect(categorize(byId.get(id)!).destructiveHint, id).toBe(false);
    }
  });

  it("flags tax-authority filing as irreversible, not as a create", () => {
    for (const id of [
      "invoices_tax_authority_report_create",
      "credit_notes_tax_authority_report_create",
      "simplified_invoices_tax_authority_report_create",
    ]) {
      expect(cat(id), id).toBe("irreversible-external");
      // A host must stop and confirm before filing with a tax authority.
      expect(categorize(byId.get(id)!).destructiveHint, id).toBe(true);
      expect(categorize(byId.get(id)!).readOnlyHint, id).toBe(false);
    }
  });

  it("flags ending a schedule early as irreversible", () => {
    for (const id of ["amortizations_end_early_create", "revenue_recognitions_end_early_create"]) {
      expect(cat(id), id).toBe("irreversible-ledger");
      expect(categorize(byId.get(id)!).destructiveHint, id).toBe(true);
    }
  });

  it("treats posting/unposting an expense as a reversible state change", () => {
    for (const id of ["expenses_mark_as_posted_create", "expenses_mark_as_draft_create"]) {
      expect(cat(id), id).toBe("state-change");
      expect(categorize(byId.get(id)!).destructiveHint, id).toBe(false);
    }
  });

  it("treats document conversions as creates", () => {
    expect(cat("quotes_invoice_create")).toBe("create");
    expect(cat("purchase_orders_bill_create")).toBe("create");
  });

  it("never marks a GET as anything but read", () => {
    for (const op of operations.filter((o: Operation) => o.method === "get")) {
      expect(categorize(op).readOnlyHint, op.operationId).toBe(true);
      expect(categorize(op).destructiveHint, op.operationId).toBe(false);
    }
  });

  it("never marks a write as readOnly", () => {
    const writeMethods = new Set(["put", "patch", "delete"]);
    for (const op of operations.filter((o: Operation) => writeMethods.has(o.method))) {
      expect(categorize(op).readOnlyHint, op.operationId).toBe(false);
    }
  });

  it("produces the expected category totals for the bundled spec", () => {
    const counts: Record<string, number> = {};
    for (const op of operations) {
      const c = categorize(op).category;
      counts[c] = (counts[c] ?? 0) + 1;
    }
    expect(counts).toEqual({
      read: 84,
      "read-pdf": 9,
      preview: 4,
      create: 39,
      update: 70,
      "state-change": 2,
      "irreversible-external": 3,
      "irreversible-ledger": 2,
      destructive: 38,
    });
  });
});
