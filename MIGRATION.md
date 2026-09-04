# Migration notes — what changed and why

This rebuild replaces a hand-written Wafeq MCP connector (18 tools, no safety
annotations, no retry/timeout/rate-limit logic) with a spec-driven one (251 generated
tools + 2 hand-written). Below is every defect that prompted the rebuild, what was
actually wrong, and where the fix lives.

Findings marked **verified live** were confirmed on **2026-09-04** against
`api.wafeq.com/v1` using read-only `GET` requests. No writes were made.

---

## Summary

| # | Defect | Status | Fixed in |
| --- | --- | --- | --- |
| 1 | Report tool sent wrong parameter names | Fixed | `src/tools.ts`, `src/overrides.ts` |
| 2 | Profit and loss rejects partial years | Fixed — and the real rule is stricter | `src/overrides.ts` |
| 3 | Trial balance "ignored" its date parameters | Fixed — root cause was the connector | `src/tools.ts` |
| 4 | No custom header support, so no idempotency key | Fixed | `src/client.ts`, `src/tools.ts` |
| 5 | No multipart support, so file upload was impossible | Fixed | `src/client.ts`, `src/openapi.ts` |
| 6 | No binary response handling beyond invoice PDFs | Fixed | `src/client.ts`, `src/openapi.ts` |
| 7 | Journal line items carry no date field | Fixed with a convenience tool | `src/extraTools.ts` |
| 8 | *(found during rebuild)* Read-only fields marked required | Fixed | `src/openapi.ts` |
| 9 | *(found during rebuild)* Wafeq silently drops unknown query params | Mitigated | design-wide |

---

## 1. The report tool sent parameter names Wafeq does not accept

**What happened.** One `wafeq_get_report` tool exposed `date_from` and `date_to` for
all four reports. Balance sheet and profit-and-loss calls returned HTTP 400 and every
report had to be run through raw requests instead.

**What's actually true.** Each report has a different parameter set, and none of them
uses `date_from`/`date_to`:

| Report | Required | Also accepts |
| --- | --- | --- |
| Balance sheet | `date`, `period_count` (0–11) | `group_by` (month\|year), `currency`, `branch__in`, `contact__in`, `project__in` |
| Profit and loss | `date_after`, `date_before` | `group_by`, `currency`, `branch__in`, `contact__in`, `project__in`, `cost_center__in` |
| Cash flow | `date_after`, `date_before` | `group_by`, `currency`, `branch__in`, `contact__in`, `project__in` |
| Trial balance | *(none)* | `from_date`, `to_date`, `with_pnl_openings`, `include_zero_balances`, `branch__in`, `contact__in`, `project__in`, `cost_center__in` |

**Verified live.**
`GET /reports/profit-and-loss/?date_from=…&date_to=…` →
`400 {"code":"required","attr":"date_after"}, {"code":"required","attr":"date_before"}`.

**Fix.** There is no shared report tool any more. Each report is generated from its
own OpenAPI operation, so each gets its own input schema straight from the spec:
`wafeq_reports_balance_sheet_list`, `wafeq_reports_profit_and_loss_list`,
`wafeq_reports_cash_flow_list`, `wafeq_reports_trial_balance_list`. Each description
also spells the parameters out (`src/overrides.ts`), because the failure mode here is
a plausible-looking wrong name.

Note: the balance sheet has **no `period_type`** parameter — the comparison period
size is `group_by`.

**Tests.** `tests/tools.test.ts` → "report tools — the parameter defect", including a
sweep asserting that `date_from`/`date_to` appear on *no* tool anywhere.

---

## 2. Profit and loss rejects partial years — and the rule is broader than that

**What happened.** `2026-01-01 → 2026-08-31` with `group_by=year` was rejected; the
same range with `group_by=month` worked.

**What's actually true.** The rule is not "no partial years". It is **the range must
start on the first day and end on the last day of a whole period**, for both period
sizes. **Verified live:**

| Request | Result |
| --- | --- |
| `date_after=2026-01-01&date_before=2026-08-31&group_by=year` | `400` — "first and last day of the **year**" |
| `date_after=2026-01-01&date_before=2026-08-31&group_by=month` | `200` |
| `date_after=2026-01-15&date_before=2026-08-31&group_by=month` | `400` — "first and last day of the **month**" |

So a mid-month start fails too, which the original report of the defect didn't cover.

**Fix.** Both the description and a local guard. `checkPeriodAlignment()` in
`src/overrides.ts` runs before the request and rejects a misaligned range **with the
nearest valid one named**, so the model can correct itself in one step instead of
learning by 400. It applies to profit-and-loss and cash flow, which share the rule.
Leap years are handled.

> Requesting a year-to-date figure? Use `group_by=month`. `group_by=year` cannot
> express a partial year at all.

**Tests.** `tests/overrides.test.ts`, plus `tests/client.test.ts` → "report guards",
which asserts no HTTP request is made for a misaligned range.

---

## 3. Trial balance "ignored" its date parameters — it was the connector, not the API

**What happened.** Trial balance returned the current year regardless of the dates
passed.

**Root cause — verified live.** The API honours its dates correctly. The connector
was sending the wrong names, and **Wafeq silently discards unknown query
parameters** instead of erroring:

| Request | Response |
| --- | --- |
| `/reports/trial-balance/?from_date=2025-01-01&to_date=2025-03-31` | `200`, 6,766 bytes |
| `/reports/trial-balance/` (no dates) | `200`, 9,810 bytes |
| `/reports/trial-balance/?date_from=2025-01-01&date_to=2025-03-31` | `200`, 9,810 bytes — **byte-identical to sending nothing** |

The dropped parameters made a working call look like a broken API. This is a
connector bug, not an API bug, and it needs no caveat in the tool description —
correct names simply work.

**Fix.** The generated tool takes `from_date` and `to_date` from the spec. The
description states the names explicitly and warns that Wafeq ignores misspelled
parameters, so a future wrong guess is recognisable rather than mysterious.

Unlike profit-and-loss, trial balance's dates are **optional**: omitting them returns
the current financial year, which is legitimate behaviour, not a bug.

---

## 4. No custom header support, so `X-Wafeq-Idempotency-Key` was unreachable

**What happened.** The passthrough accepted method, path, query and body — no
headers. Wafeq's own recommended protection against duplicate POSTs was therefore
impossible to use, through any tool.

**What's actually true.** `X-Wafeq-Idempotency-Key` is declared in the spec on **146
of 158 write operations** (all 35 `PUT`, all 35 `PATCH`, all 38 `DELETE`, and 38 of
50 `POST`). It was always available; nothing could send it.

**Fix, in three parts:**

1. Every generated tool whose operation declares the header gets an optional
   `idempotency_key` argument — the friendly alias, so the model never has to type a
   raw header name.
2. **A UUID v4 is generated automatically when none is supplied**, and is created
   *once per call, before the retry loop*, so all attempts of one call carry the same
   key. This is precisely what Wafeq's integration guide asks for ("retry with the
   same idempotency key"), and it means an automatic retry can never duplicate an
   invoice.
3. `wafeq_request` now takes a `headers` object, so anything not covered by a
   generated tool can still set it. `Authorization` is stripped from that object and
   always set from the environment.

**Tests.** `tests/client.test.ts` → "idempotency", including the key being identical
across a retried request and absent on reads.

---

## 5. No multipart support, so files could not be uploaded at all

**What happened.** A JSON-only body meant `POST /files/` was unusable and attachments
could not be uploaded.

**What's actually true.** Two upload endpoints, neither of which takes JSON:

- `POST /files/` — `multipart/form-data` only, field name `file`.
- `POST /files/raw/` — body content type `*/*`, with a **required**
  `Content-Disposition` header.

**Fix.** `src/openapi.ts` detects both shapes from the spec (`multipart` and
`rawBinaryUpload`), and `src/client.ts` builds the right request for each. Both tools
take `file_base64` + `filename` (plus optional `content_type`, guessed from the
extension when omitted). `Content-Disposition` is constructed for you, RFC 6266
encoded so non-ASCII filenames survive.

Two details that matter in practice:

- The multipart body is built **fresh for each attempt**, because a `FormData` body
  is a one-shot stream — reusing it would send an empty body on a retry.
- `Content-Type` is deliberately not set for multipart, so `fetch` can add the
  boundary.

There is also a `file_path` argument for files already on the server's disk, but it
is **disabled unless `WAFEQ_ALLOW_LOCAL_FILE_UPLOAD=true`**: with it on, anything that
can reach the server can ask it to read a local file. Uploads are capped at 25 MiB
by default.

**Tests.** `tests/client.test.ts` → "file uploads", including the retry-rebuild case
and the refusal to read local files by default.

---

## 6. Binary responses were handled for exactly one endpoint

**What happened.** PDF downloads were described as unhandled. In fairness the old
connector *did* base64-encode one of them — `wafeq_download_invoice_pdf`. The other
**eight** PDF endpoints (bill, credit note, debit note, quote, purchase order,
payment, payslip, simplified invoice) had no tool and could only be reached through
the passthrough, which read every response as text and corrupted them.

**Fix.** Binary handling is now driven by the spec rather than by a hand-written
special case. `src/openapi.ts` records any non-JSON success content type; all nine
`application/pdf` endpoints are detected automatically, categorized
🟢 `READ-ONLY · returns a PDF`, and returned as:

```json
{ "encoding": "base64", "content_type": "application/pdf", "size_bytes": 51234,
  "filename": "INV-2026-014.pdf", "data": "JVBERi0xLjcK…" }
```

A failed PDF request is still read as JSON — Wafeq answers those with a JSON error
body, not a PDF — so an error message never arrives base64-encoded.

**Tests.** `tests/client.test.ts` → "binary responses", including a byte-for-byte
round trip and the JSON-error case.

---

## 7. Journal line items carry no transaction date

**What happened.** `GET /journal-line-items/` returns `created_ts` but no transaction
date, so tracing an account's history meant joining to `/manual-journals/` on the
journal reference.

**What's actually true — verified live.** Confirmed: the schema has `account`,
`amount`, `journal`, `created_ts`, `modified_ts` and no date. A real January 2026
transaction in these books carries `created_ts: 2026-02-06` — a different month — so
reading `created_ts` as the transaction date is actively wrong, not merely imprecise.

**But the join isn't necessary.** The list endpoint accepts `date_after` and
`date_before` filters that **do** operate on the real transaction date. Verified live:
`?date_after=2026-01-01&date_before=2026-01-31` returns exactly the January rows.

A join to `/manual-journals/` would also have been incomplete: most journals originate
from invoices, bills and payments rather than manual journals, and those rows would
have come back dateless.

**Fix — both halves of the option:**

- The generated tools' descriptions warn that `created_ts` is not the transaction
  date and point at the date filters. (They also note that this endpoint is
  **cursor-paginated**, unlike the rest of the API, which uses `page`.)
- **`wafeq_account_ledger`** returns rows with a real `date` on each one. It recovers
  the date from Wafeq's own filter: probe a month, and only if that month has rows,
  query its days. A quiet month costs one request. The result reports `requests_made`
  and `dates_resolved` so the cost is never hidden. Windows wider than 92 days return
  rows without dates and say so rather than firing hundreds of requests.

**Tests.** `tests/extraTools.test.ts`, including the month-pruning behaviour and the
over-wide-range fallback.

---

## 8. Found during the rebuild: read-only fields were marked required

Not in the original list, but it would have made most write tools unusable, and it
affects any generic OpenAPI wrapper pointed at this spec.

**The problem.** Wafeq's spec is generated by drf-spectacular, which reuses one
schema for requests and responses. Server-assigned fields are marked
`readOnly: true` **and** listed in `required`. `Invoice` requires seven of them:
`id`, `created_ts`, `modified_ts`, `legacy_id`, `balance`, `amount`, `tax_amount`.
**64 of the spec's 158 object schemas** have this problem.

Handed to a model unchanged, `wafeq_invoices_create` would demand an `id` and a
`balance` for an invoice that doesn't exist yet — so the model either invents them or
refuses.

**Fix.** `stripReadOnly()` in `src/openapi.ts` removes `readOnly` properties from
**request** bodies and prunes them from `required`, recursively (nested objects and
array items included). This is what OpenAPI specifies — read-only properties "MUST
NOT be sent as part of the request" — so it is spec-correct, not a workaround.

**Tests.** `tests/openapi.test.ts` → `stripReadOnly`, including a sweep asserting no
request body anywhere requires a `readOnly` field.

---

## 9. Found during the rebuild: Wafeq silently drops unknown query parameters

This is the reason defects 1 and 3 presented so differently. Where a wrong parameter
name replaced a **required** one, the call failed loudly (`400`, profit-and-loss).
Where it replaced an **optional** one, the call succeeded and returned the default
period (trial balance) — a wrong answer that looks like a right one.

There's no server-side switch for this, so the mitigation is structural: parameter
names come from the spec rather than from memory, `additionalProperties: false` on
every generated input schema stops the model inventing extras, and the tests sweep
for `date_from`/`date_to` across the whole catalogue.

---

## Beyond the defect list

Changes that come with the rebuild rather than from a specific bug:

| Area | Before | After |
| --- | --- | --- |
| **Coverage** | 18 hand-written tools | 251 generated + 2 hand-written |
| **Source of truth** | Hand-maintained tool definitions | `spec/wafeq-public-api.json`, parsed at startup |
| **Safety signalling** | None | 9 categories, banner on every description, `readOnlyHint`/`destructiveHint` annotations |
| **Tax-authority filing** | An ordinary tool | 🔴 `IRREVERSIBLE`, `destructiveHint: true` |
| **Previews** | Not exposed | 🟢 read-only, so a host can auto-trust them |
| **Retries** | None | Jittered exponential backoff on 429/5xx, honours `Retry-After` |
| **Rate limiting** | None | Sliding window, configurable |
| **Timeouts** | None | Per-attempt, with abort |
| **Tenant check** | None | `GET /organization/` at startup, published on `/health` |
| **Passthrough safety** | Could not set headers | Full headers; `Authorization` non-overridable; refuses other hosts |
| **Schema size** | n/a (18 tools) | Single-member `allOf` flattened and duplicated enum prose dropped — ~29% off the `tools/list` payload, no allowed values lost |
| **Tests** | None | 106 tests across 7 files, CI on Node 20 and 22 |

### On the escape hatch

`wafeq_request` is still there and is more capable, but it is now the fallback rather
than the interface. It is categorized 🔴 destructive: the tool's effect depends
entirely on its arguments, so it cannot honestly claim to be anything safer.

### What was not changed

- **Trial balance dates stay optional.** Omitting them returns the current financial
  year. That's Wafeq's documented behaviour, not a defect.
- **`created_ts` is still returned** on journal line items. It's real data — it just
  isn't the transaction date, and now says so.
- **Balance sheet has no date range.** It is an "as of" report by design;
  `period_count` adds comparison periods.
