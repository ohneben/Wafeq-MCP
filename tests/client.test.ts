import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { authorizationHeader, callOperation, callRaw, contentDisposition, guessContentType, __test, type WafeqConfig } from "../src/client.js";
import { loadOpenApi, type Operation } from "../src/openapi.js";

const { operations } = loadOpenApi(resolve(__dirname, "..", "spec", "wafeq-public-api.json"));
const op = (id: string): Operation => operations.find((o) => o.operationId === id)!;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function cfg(fetchImpl: typeof fetch, extra: Partial<WafeqConfig> = {}): WafeqConfig {
  return {
    baseUrl: "https://api.wafeq.com/v1",
    apiToken: "test-key",
    authScheme: "api-key",
    fetchImpl,
    maxRetries: 0,
    timeoutMs: 1000,
    ...extra,
  };
}

describe("authorization", () => {
  it("uses `Api-Key` for private keys and `Bearer` for OAuth tokens", () => {
    expect(authorizationHeader({ apiToken: "abc", authScheme: "api-key" } as WafeqConfig)).toBe("Api-Key abc");
    expect(authorizationHeader({ apiToken: "abc", authScheme: "bearer" } as WafeqConfig)).toBe("Bearer abc");
  });

  it("leaves a token that already carries its scheme alone", () => {
    expect(authorizationHeader({ apiToken: "Api-Key xyz", authScheme: "bearer" } as WafeqConfig)).toBe("Api-Key xyz");
  });

  it("injects the credential server-side on every request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    await callOperation(cfg(fetchMock as unknown as typeof fetch), op("invoices_list"), {});
    const headers = (fetchMock.mock.calls[0] as any)[1].headers;
    expect(headers.Authorization).toBe("Api-Key test-key");
  });
});

describe("request building", () => {
  it("expands path parameters and encodes them", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    await callOperation(cfg(fetchMock as unknown as typeof fetch), op("invoices_retrieve"), { id: "inv 1/2" });
    expect((fetchMock.mock.calls[0] as any)[0]).toBe("https://api.wafeq.com/v1/invoices/inv%201%2F2/");
  });

  it("serializes each array parameter the way the spec declares it", async () => {
    // Wafeq's `__in` filters are django-filter BaseInFilters: the spec marks them
    // `explode: false`, meaning one comma-separated value. `status__in` is
    // `explode: true` and repeats the key. Getting this backwards silently returns
    // the wrong rows rather than erroring, so both are pinned here.
    const fetchMock = vi.fn(async () => jsonResponse({}));
    await callOperation(cfg(fetchMock as unknown as typeof fetch), op("reports_balance_sheet_list"), {
      date: "2026-08-31",
      period_count: 1,
      project__in: ["p1", "p2"],
    });
    const url = (fetchMock.mock.calls[0] as any)[0] as string;
    expect(decodeURIComponent(url)).toContain("project__in=p1,p2");
    expect(url).toContain("date=2026-08-31");

    const repeatMock = vi.fn(async () => jsonResponse({}));
    await callOperation(cfg(repeatMock as unknown as typeof fetch), op("amortizations_list"), {
      status__in: ["DRAFT", "SENT"],
    });
    expect((repeatMock.mock.calls[0] as any)[0]).toContain("status__in=DRAFT&status__in=SENT");
  });

  it("sends the JSON body for creates", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
    await callOperation(cfg(fetchMock as unknown as typeof fetch), op("contacts_create"), {
      body: { name: "Acme" },
    });
    const init = (fetchMock.mock.calls[0] as any)[1];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "Acme" }));
  });
});

describe("idempotency", () => {
  it("generates a UUID v4 when the caller supplies none", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
    await callOperation(cfg(fetchMock as unknown as typeof fetch), op("contacts_create"), { body: {} });
    const key = (fetchMock.mock.calls[0] as any)[1].headers["X-Wafeq-Idempotency-Key"];
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("uses a caller-supplied key verbatim", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
    await callOperation(cfg(fetchMock as unknown as typeof fetch), op("contacts_create"), {
      body: {},
      idempotency_key: "order-4711",
    });
    expect((fetchMock.mock.calls[0] as any)[1].headers["X-Wafeq-Idempotency-Key"]).toBe("order-4711");
  });

  it("reuses the SAME key across retries, so a retry is not a new operation", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return calls === 1 ? jsonResponse({ err: 1 }, 503) : jsonResponse({ ok: true }, 201);
    });
    await callOperation(
      cfg(fetchMock as unknown as typeof fetch, { maxRetries: 2 }),
      op("contacts_create"),
      { body: {} },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = (fetchMock.mock.calls[0] as any)[1].headers["X-Wafeq-Idempotency-Key"];
    const second = (fetchMock.mock.calls[1] as any)[1].headers["X-Wafeq-Idempotency-Key"];
    expect(second).toBe(first);
  });

  it("never sends the header on a read", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    await callOperation(cfg(fetchMock as unknown as typeof fetch), op("invoices_list"), {});
    expect((fetchMock.mock.calls[0] as any)[1].headers["X-Wafeq-Idempotency-Key"]).toBeUndefined();
  });
});

describe("resilience", () => {
  it("retries 429 and 5xx, but not 4xx", async () => {
    for (const status of [429, 500, 503]) {
      let n = 0;
      const fetchMock = vi.fn(async () => {
        n++;
        return n === 1 ? jsonResponse({}, status) : jsonResponse({ ok: true });
      });
      const res = await callOperation(
        cfg(fetchMock as unknown as typeof fetch, { maxRetries: 2 }),
        op("invoices_list"),
        {},
      );
      expect(res.ok, `status ${status}`).toBe(true);
      expect(fetchMock, `status ${status}`).toHaveBeenCalledTimes(2);
    }

    const fetchMock400 = vi.fn(async () => jsonResponse({ detail: "bad" }, 400));
    const res = await callOperation(
      cfg(fetchMock400 as unknown as typeof fetch, { maxRetries: 2 }),
      op("invoices_list"),
      {},
    );
    expect(fetchMock400).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
  });

  it("honours Retry-After in seconds and as an HTTP date", () => {
    expect(__test.parseRetryAfter("2")).toBe(2000);
    expect(__test.parseRetryAfter(null)).toBeUndefined();
    const future = new Date(Date.now() + 5000).toUTCString();
    expect(__test.parseRetryAfter(future)).toBeGreaterThan(3000);
  });

  it("keeps jittered backoff inside its cap", () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const d = __test.backoffDelay(attempt);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });

  it("aborts a request that outruns the timeout", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    await expect(
      callOperation(cfg(fetchMock as unknown as typeof fetch, { timeoutMs: 20 }), op("invoices_list"), {}),
    ).rejects.toThrow(/timed out after 20ms/);
  });
});

describe("binary responses", () => {
  it("base64-encodes a PDF instead of mangling it as text", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]);
    const fetchMock = vi.fn(
      async () =>
        new Response(pdf, {
          status: 200,
          headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="inv.pdf"' },
        }),
    );
    const res = await callOperation(
      cfg(fetchMock as unknown as typeof fetch),
      op("invoices_download_retrieve"),
      { id: "inv_1" },
    );
    expect(res.binary).toBe(true);
    const body = res.body as { encoding: string; data: string; size_bytes: number; filename?: string };
    expect(body.encoding).toBe("base64");
    expect(body.size_bytes).toBe(10);
    expect(body.filename).toBe("inv.pdf");
    expect(Buffer.from(body.data, "base64")).toEqual(Buffer.from(pdf));
  });

  it("reads a JSON error from a PDF endpoint as JSON, not as bytes", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ detail: "Not found" }, 404));
    const res = await callOperation(
      cfg(fetchMock as unknown as typeof fetch),
      op("invoices_download_retrieve"),
      { id: "nope" },
    );
    expect(res.binary).toBeUndefined();
    expect(res.body).toEqual({ detail: "Not found" });
  });

  it("reports a 204 delete as a result rather than an empty string", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const res = await callOperation(cfg(fetchMock as unknown as typeof fetch), op("invoices_destroy"), { id: "i" });
    expect(res.body).toEqual({ deleted: true, status: 204 });
  });
});

describe("file uploads", () => {
  it("builds a multipart body for POST /files/", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "file_1" }, 201));
    await callOperation(cfg(fetchMock as unknown as typeof fetch), op("upload_file"), {
      file_base64: Buffer.from("hello").toString("base64"),
      filename: "note.txt",
    });
    const init = (fetchMock.mock.calls[0] as any)[1];
    expect(init.body).toBeInstanceOf(FormData);
    const file = (init.body as FormData).get("file") as File;
    expect(file.name).toBe("note.txt");
    expect(await file.text()).toBe("hello");
    // fetch must set Content-Type itself so the multipart boundary is included.
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("sends raw bytes with a Content-Disposition header for POST /files/raw/", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "file_2" }, 201));
    await callOperation(cfg(fetchMock as unknown as typeof fetch), op("upload_file_raw"), {
      file_base64: Buffer.from("%PDF-").toString("base64"),
      filename: "receipt.pdf",
    });
    const init = (fetchMock.mock.calls[0] as any)[1];
    expect(init.headers["Content-Type"]).toBe("application/pdf");
    expect(init.headers["Content-Disposition"]).toContain('filename="receipt.pdf"');
    expect(Buffer.from(init.body).toString()).toBe("%PDF-");
  });

  it("rebuilds the body on a retry instead of resending a consumed stream", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n === 1 ? jsonResponse({}, 503) : jsonResponse({ id: "f" }, 201);
    });
    await callOperation(cfg(fetchMock as unknown as typeof fetch, { maxRetries: 2 }), op("upload_file"), {
      file_base64: Buffer.from("data").toString("base64"),
      filename: "a.txt",
    });
    const first = (fetchMock.mock.calls[0] as any)[1].body;
    const second = (fetchMock.mock.calls[1] as any)[1].body;
    expect(first).not.toBe(second);
    expect(await ((second as FormData).get("file") as File).text()).toBe("data");
  });

  it("refuses to read local files unless explicitly permitted", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
    await expect(
      callOperation(cfg(fetchMock as unknown as typeof fetch), op("upload_file"), {
        file_path: "/etc/passwd",
        filename: "x",
      }),
    ).rejects.toThrow(/WAFEQ_ALLOW_LOCAL_FILE_UPLOAD/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an upload over the size cap", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
    await expect(
      callOperation(cfg(fetchMock as unknown as typeof fetch, { maxUploadBytes: 4 }), op("upload_file"), {
        file_base64: Buffer.from("far too long").toString("base64"),
        filename: "big.txt",
      }),
    ).rejects.toThrow(/over the 4-byte limit/);
  });

  it("guesses a content type and quotes awkward filenames", () => {
    expect(guessContentType("a.pdf")).toBe("application/pdf");
    expect(guessContentType("a.unknown")).toBe("application/octet-stream");
    expect(contentDisposition('we"ird.pdf')).toContain('filename="we_ird.pdf"');
    expect(contentDisposition("rechnung-über.pdf")).toContain("filename*=UTF-8''");
  });
});

describe("report guards", () => {
  it("rejects a misaligned range locally, without spending a request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    await expect(
      callOperation(cfg(fetchMock as unknown as typeof fetch), op("reports_profit_and_loss_list"), {
        date_after: "2026-01-01",
        date_before: "2026-08-31",
        group_by: "year",
      }),
    ).rejects.toThrow(/group_by=year/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a valid range through", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const res = await callOperation(cfg(fetchMock as unknown as typeof fetch), op("reports_profit_and_loss_list"), {
      date_after: "2026-01-01",
      date_before: "2026-08-31",
    });
    expect(res.ok).toBe(true);
  });
});

describe("passthrough (callRaw)", () => {
  it("sends method, path, query, body and custom headers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    await callRaw(cfg(fetchMock as unknown as typeof fetch), {
      method: "post",
      path: "/anything/",
      query: { a: 1, b: ["x", "y"] },
      body: { hello: "world" },
      headers: { "X-Custom": "1" },
    });
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toContain("https://api.wafeq.com/v1/anything/?a=1&b=x&b=y");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Custom"]).toBe("1");
    expect(init.body).toBe(JSON.stringify({ hello: "world" }));
  });

  it("adds an idempotency key to writes and leaves reads alone", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    await callRaw(cfg(fetchMock as unknown as typeof fetch), { method: "POST", path: "/x/" });
    expect((fetchMock.mock.calls[0] as any)[1].headers["X-Wafeq-Idempotency-Key"]).toBeDefined();

    const readMock = vi.fn(async () => jsonResponse({}));
    await callRaw(cfg(readMock as unknown as typeof fetch), { method: "GET", path: "/x/" });
    expect((readMock.mock.calls[0] as any)[1].headers["X-Wafeq-Idempotency-Key"]).toBeUndefined();
  });

  it("refuses to let a caller override Authorization", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    await callRaw(cfg(fetchMock as unknown as typeof fetch), {
      method: "GET",
      path: "/x/",
      headers: { Authorization: "Api-Key stolen", authorization: "Bearer nope" },
    });
    expect((fetchMock.mock.calls[0] as any)[1].headers.Authorization).toBe("Api-Key test-key");
  });

  it("refuses to send credentials to another host", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    await expect(
      callRaw(cfg(fetchMock as unknown as typeof fetch), { method: "GET", path: "https://evil.example/steal" }),
    ).rejects.toThrow(/Refusing to send credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
