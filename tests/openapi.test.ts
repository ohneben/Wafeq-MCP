import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { assignArgNames, buildOperations, loadOpenApi, stripReadOnly, TOOL_ARG_KEY } from "../src/openapi.js";

const SPEC = resolve(__dirname, "..", "spec", "wafeq-public-api.json");
const { operations } = loadOpenApi(SPEC);

describe("spec loading", () => {
  it("loads every operation from the bundled spec", () => {
    expect(operations.length).toBe(251);
  });

  it("gives every operation a unique operationId", () => {
    const ids = new Set(operations.map((o) => o.operationId));
    expect(ids.size).toBe(operations.length);
  });

  it("resolves $refs in request bodies rather than leaving them dangling", () => {
    const create = operations.find((o) => o.operationId === "invoices_create")!;
    expect(create.requestBodySchema).toBeDefined();
    expect(JSON.stringify(create.requestBodySchema)).not.toContain("$ref");
    const props = (create.requestBodySchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toContain("contact");
    expect(Object.keys(props)).toContain("line_items");
  });

  it("guards against recursive schemas instead of hanging", () => {
    // A self-referential schema must terminate with a stub, not blow the stack.
    const doc = {
      paths: {
        "/x/": {
          post: {
            operationId: "x_create",
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } },
            responses: {},
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: { child: { $ref: "#/components/schemas/Node" }, name: { type: "string" } },
          },
        },
      },
    };
    const { operations: ops } = buildOperations(doc);
    const json = JSON.stringify(ops[0].requestBodySchema);
    expect(json).toContain("Recursive reference");
    expect(json).toContain("name");
  });
});

describe("stripReadOnly", () => {
  it("removes readOnly properties and prunes them from required", () => {
    const out = stripReadOnly({
      type: "object",
      required: ["id", "contact", "amount"],
      properties: {
        id: { type: "string", readOnly: true },
        amount: { type: "number", readOnly: true },
        contact: { type: "string" },
      },
    }) as { required: string[]; properties: Record<string, unknown> };
    expect(Object.keys(out.properties)).toEqual(["contact"]);
    expect(out.required).toEqual(["contact"]);
  });

  it("drops `required` entirely when nothing writable remains", () => {
    const out = stripReadOnly({
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", readOnly: true } },
    }) as Record<string, unknown>;
    expect(out.required).toBeUndefined();
  });

  it("recurses into nested objects and arrays", () => {
    const out = stripReadOnly({
      type: "object",
      properties: {
        line_items: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "amount"],
            properties: { id: { type: "string", readOnly: true }, amount: { type: "number" } },
          },
        },
      },
    }) as any;
    expect(Object.keys(out.properties.line_items.items.properties)).toEqual(["amount"]);
    expect(out.properties.line_items.items.required).toEqual(["amount"]);
  });

  it("keeps server-assigned fields out of every generated create body", () => {
    // Regression: drf-spectacular marks readOnly fields as required, which made
    // create tools demand `id`, `created_ts`, `balance` and friends.
    const create = operations.find((o) => o.operationId === "invoices_create")!;
    const schema = create.requestBodySchema as { required?: string[]; properties: Record<string, unknown> };
    for (const forbidden of ["id", "created_ts", "modified_ts", "legacy_id", "balance", "amount", "tax_amount"]) {
      expect(Object.keys(schema.properties)).not.toContain(forbidden);
      expect(schema.required ?? []).not.toContain(forbidden);
    }
  });

  it("leaves no request body anywhere demanding a readOnly field", () => {
    for (const op of operations) {
      const schema = op.requestBodySchema as { required?: string[]; properties?: Record<string, any> } | undefined;
      if (!schema?.required || !schema.properties) continue;
      for (const key of schema.required) {
        expect(schema.properties[key], `${op.operationId} requires missing property ${key}`).toBeDefined();
        expect(schema.properties[key]?.readOnly, `${op.operationId}.${key} is readOnly but required`).not.toBe(true);
      }
    }
  });
});

describe("operation metadata", () => {
  it("detects the nine binary PDF endpoints", () => {
    const binary = operations.filter((o) => o.binaryResponseType);
    expect(binary.length).toBe(9);
    expect(binary.every((o) => o.binaryResponseType === "application/pdf")).toBe(true);
    expect(binary.map((o) => o.operationId)).toContain("invoices_download_retrieve");
  });

  it("detects the multipart and raw upload endpoints", () => {
    expect(operations.find((o) => o.operationId === "upload_file")!.multipart).toBe(true);
    expect(operations.find((o) => o.operationId === "upload_file_raw")!.rawBinaryUpload).toBe(true);
    // A create that merely *offers* multipart alongside JSON must still send JSON.
    const invoice = operations.find((o) => o.operationId === "invoices_create")!;
    expect(invoice.multipart).toBe(false);
    expect(invoice.requestBodyContentType).toBe("application/json");
  });

  it("detects idempotency support without exposing the auth header", () => {
    const create = operations.find((o) => o.operationId === "invoices_create")!;
    expect(create.supportsIdempotencyKey).toBe(true);
    const read = operations.find((o) => o.operationId === "invoices_list")!;
    expect(read.supportsIdempotencyKey).toBe(false);
    for (const op of operations) {
      const headers = op.parameters.filter((p) => p.in === "header").map((p) => p.name.toLowerCase());
      expect(headers).not.toContain("authorization");
    }
  });

  it("gives every parameter a schema-legal argName", () => {
    for (const op of operations) {
      for (const p of op.parameters) {
        expect(TOOL_ARG_KEY.test(p.argName ?? ""), `${op.operationId}: ${p.name}`).toBe(true);
      }
    }
  });

  it("sanitizes and de-duplicates illegal parameter names", () => {
    const out = assignArgNames([
      { name: "cf_$field", in: "query", required: false },
      { name: "cf_%field", in: "query", required: false },
      { name: "ok_name", in: "query", required: false },
    ]);
    // The illegal character becomes an underscore, so the two names collide and
    // the second gets a numeric suffix.
    expect(out[0].argName).toBe("cf__field");
    expect(out[1].argName).toBe("cf__field_2");
    expect(out[2].argName).toBe("ok_name");
  });
});
