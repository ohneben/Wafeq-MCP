# ohneben's Wafeq MCP

[![CI](https://github.com/ohneben/Wafeq-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/ohneben/Wafeq-MCP/actions/workflows/ci.yml)
[![Publish Docker image](https://github.com/ohneben/Wafeq-MCP/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/ohneben/Wafeq-MCP/actions/workflows/docker-publish.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE.md)

Run your [Wafeq](https://www.wafeq.com/) books in plain language from AI assistants
like **Claude**, **Cursor**, and any other [MCP](https://modelcontextprotocol.io)
client.

This [Model Context Protocol](https://modelcontextprotocol.io) server exposes the
**Wafeq Public API** — all **251 endpoints**, generated straight from the OpenAPI
spec into MCP tools, plus two hand-written ones. Every tool carries a **safety
category** (🟢 read-only / 🟡 write / 🟠 state change / 🔴 irreversible or
destructive) so your assistant knows what an action does *before* it calls it —
including the difference between saving an invoice and **filing it with a tax
authority**, which no CRUD-shaped wrapper can tell you. It runs over **stdio**
(Claude Desktop and other local launchers) or **Streamable HTTP** (hosted in Docker),
and ships with retries, client-side rate limiting, request timeouts, idempotency
keys, multipart upload and binary PDF handling so it holds up against a live book.

## Why you'll want this

Some MCP servers just forward an API. This one is built to be **safe to hand to an
LLM** and **easy to run against real accounting data**:

| What you get | Why it matters |
| --- | --- |
| **All 251 endpoints, spec-driven** | Full coverage of invoices, bills, quotes, credit and debit notes, payments, banking, journals, payroll, projects, inventory and reports — nothing hand-picked or left behind. |
| **Nine safety categories, not four** 🟢 / 🟡 / 🟠 / 🔴 | A dozen of Wafeq's POSTs are not creates. Previews write nothing; ending an amortization early posts to the ledger with no undo; reporting an invoice to a tax authority leaves your organization permanently. Each gets its own banner instead of being lumped in with "create". |
| **Machine-readable MCP annotations** (`readOnlyHint`, `destructiveHint`) | Hosts that honor annotations (Claude included) can auto-trust the 98 read-only tools and demand confirmation before any of the 44 that delete or cannot be undone. |
| **Correct report parameters, per report** | Each of the four reports gets its own schema: balance sheet takes `date` + `period_count`; profit-and-loss and cash flow take `date_after` + `date_before`; trial balance takes `from_date` + `to_date`. Wafeq **silently ignores** misspelled query parameters, so a wrong name looks like a working call. |
| **Whole-period validation before sending** | Profit-and-loss and cash flow reject ranges that don't align to whole months or years. The server checks locally and replies with the nearest valid range instead of spending a round trip on an HTTP 400. |
| **Automatic idempotency keys** | Every one of the 146 write endpoints that supports `X-Wafeq-Idempotency-Key` gets a UUID v4 automatically, reused across retries — so a network hiccup can never duplicate an invoice. Supply your own to make a deliberate re-run safe too. |
| **File uploads that actually work** | `POST /files/` is multipart-only and `POST /files/raw/` needs a `Content-Disposition` header. Both are handled; you pass base64 content and a filename. |
| **Binary PDFs handled as bytes** | The nine PDF endpoints are base64-encoded into a small envelope with size and content type, instead of being read as text and corrupted. |
| **Automatic retries with backoff** | Transient `429` / `5xx` responses are retried with jittered exponential backoff, honoring `Retry-After` — with the same idempotency key, exactly as Wafeq's integration guide requires. |
| **Built-in rate limiting** | Self-throttles so a burst of tool calls doesn't trip a `429`. Wafeq publishes no numeric limit, so the default is deliberately conservative and configurable. |
| **Tenant verified at startup** | A Wafeq API key is organization-scoped. The server calls `GET /organization/` before serving and publishes the result on `/health`, so a mis-set key shows up as a name you can check rather than as writes against the wrong company's books. |
| **Two transports: stdio *and* Streamable HTTP** | Use it locally in Claude Desktop, or run one always-on server that any number of MCP clients reach over HTTP. |
| **Docker + docker-compose, health check, auto-restart** | `docker compose up` and it stays up, bound to localhost only. |
| **Optional bearer-token auth** on the HTTP endpoint | Put the server behind a shared secret the moment it's reachable beyond localhost. |
| **Your secrets never reach the model** | Credentials live in the server's environment and are injected on every request. The passthrough tool cannot override `Authorization` or point the credential at another host. |
| **Drop-in spec updates** | Wafeq ships a newer spec? Replace one file and rebuild — new endpoints become new tools automatically, no code changes. |

### How it compares

| Capability | **This project** | Generic OpenAPI→MCP wrapper\* |
| --- | :---: | :---: |
| All 251 Wafeq endpoints as tools | ✅ | ✅ |
| Per-tool safety category + banner | ✅ | ❌ |
| Tax-authority filing flagged as irreversible, not "create" | ✅ | ❌ |
| `readOnlyHint` / `destructiveHint` MCP annotations | ✅ | ➖ |
| Read-only fields stripped from create/update bodies | ✅ | ❌ |
| Correct, per-report date parameters | ✅ | ✅ |
| Whole-period range validated before sending | ✅ | ❌ |
| Automatic `X-Wafeq-Idempotency-Key`, stable across retries | ✅ | ❌ |
| Multipart + raw-binary file upload | ✅ | ➖ |
| Binary PDF responses base64-encoded, not mangled | ✅ | ➖ |
| Transaction dates recovered for journal line items | ✅ | ❌ |
| Automatic retries on `429` / `5xx` (honors `Retry-After`) | ✅ | ❌ |
| Client-side rate limiting | ✅ | ❌ |
| Organization identity verified at startup | ✅ | ❌ |
| `stdio` transport | ✅ | ✅ |
| **Streamable-HTTP transport** | ✅ | ➖ |
| **Docker + docker-compose**, health check, auto-restart | ✅ | ❌ |
| **Optional bearer-token auth** on the endpoint | ✅ | ❌ |
| License | MIT | varies |

<sub>\*Generic OpenAPI→MCP wrappers turn any spec into MCP tools. They can reach the
same endpoints, but treat every operation identically — and against Wafeq's spec
specifically they inherit the read-only-required-field problem described in
[MIGRATION.md](./MIGRATION.md). "➖" = varies by tool / not guaranteed.</sub>

## What you can do

Once it's connected, ask your assistant things like:

- "What was our profit and loss for the first half of this year?"
- "Show me every unpaid invoice older than 30 days, with the customer name."
- "Create a draft invoice for Acme Ltd for 3 days of consulting at €800/day."
- "Download invoice INV-2026-014 as a PDF."
- "Which account did the €7,000 transfer in January post to?"
- "Attach this receipt to expense EXP-118."
- "Reconcile the bank statement lines for March against the ledger."
- "Convert quote QUO-31 to an invoice and record the payment."

## How it works

```
Claude / Cursor / any MCP client  ──MCP──►  this server  ──HTTPS──►  Wafeq API (your organization)
```

At startup the server parses the bundled OpenAPI spec into MCP tools — resolving
`$ref`s, guarding against recursive schemas, and stripping server-assigned
(`readOnly`) fields out of request bodies — tags each tool with its safety category,
verifies which Wafeq organization the credentials belong to, and then injects your
credential on every outgoing request. Your key stays in the server's environment; the
model never sees or handles it.

## Requirements

- A **Wafeq organization with API access** — either a private **API key** (Wafeq →
  Settings → Developer → API keys) or an **OAuth2 access token**. See
  [Get your API credentials](#get-your-api-credentials).
- **Docker** (Docker Desktop on macOS/Windows) for the quick start below — or
  **Node.js ≥ 20** to [run from source](#run-from-source-stdio-no-docker).

## Quick start (Docker)

**1. Add your credentials.** Copy the example config and fill it in:

```bash
cp .env.example .env
```

Then edit `.env` and set `WAFEQ_API_KEY`. If the server will be reachable beyond
localhost, set `MCP_SHARED_TOKEN` to a long random string as well.

**2. Start the server:**

```bash
docker compose up -d --build
```

`docker-compose.yml` binds to `127.0.0.1:8765` only, so the server is reachable from
your machine but not from the network.

**3. Confirm it's running — and that it's pointed at the right books:**

```bash
curl -s http://localhost:8765/health
```

```json
{
  "status": "ok",
  "server": "wafeq-mcp",
  "version": "2.0.0",
  "tools": 253,
  "organization": {
    "status": "ok",
    "id": "org_...",
    "name": "Your Company FZCO",
    "base_currency": "EUR",
    "country": "AE"
  },
  "auth_required": false
}
```

**Check the `name` field.** That is the organization your key writes to. If it isn't
the company you expected, stop and fix the key before doing anything else. `/health`
answers `503` and `"status": "degraded"` when the credentials can't be verified.

**4. Point your MCP client at it:** `http://localhost:8765/mcp` (Streamable HTTP). If
you set `MCP_SHARED_TOKEN`, send it as `Authorization: Bearer <token>`.

## Get your API credentials

**Private API key (most people):** in Wafeq, go to **Settings → Developer → API
keys** and create a key. It is scoped to one organization. Put it in `.env` as
`WAFEQ_API_KEY`; the server sends it as `Authorization: Api-Key <key>`.

**OAuth2 app:** if you have an access token from a Wafeq OAuth2 app, put it in
`.env` as `WAFEQ_ACCESS_TOKEN` instead. The server switches to
`Authorization: Bearer <token>` automatically. Set `WAFEQ_AUTH_SCHEME` only if you
need to force one scheme while both variables are present.

## Configuration

All configuration is environment variables. Everything except the credential has a
working default.

| Variable | Default | What it does |
| --- | --- | --- |
| `WAFEQ_API_KEY` | — | Private organization API key. Sent as `Api-Key <key>`. **One credential is required.** |
| `WAFEQ_ACCESS_TOKEN` | — | OAuth2 access token. Sent as `Bearer <token>`. Takes precedence over `WAFEQ_API_KEY`. |
| `WAFEQ_AUTH_SCHEME` | auto | Force `api-key` or `bearer`. Normally leave unset. |
| `WAFEQ_API_BASE_URL` | `https://api.wafeq.com/v1` | Wafeq API base URL. |
| `WAFEQ_OPENAPI_PATH` | bundled spec | Use a different OpenAPI document (JSON or YAML). |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http`. Docker sets `http`. |
| `PORT` | `8765` | HTTP listen port. |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `MCP_HTTP_PATH` | `/mcp` | Path the MCP endpoint is served on. |
| `MCP_SHARED_TOKEN` | — | Bearer token required on `/mcp`. Empty = no auth. **Set it if the port is reachable beyond localhost.** |
| `WAFEQ_TOOL_GROUPS` | — | Comma-separated resource groups to expose, e.g. `invoices,bills,reports`. Empty = all 251. Run `npm run list-tools` for the list. |
| `WAFEQ_MAX_REQUESTS` | `20` | Client-side rate limit: requests per window. `0` disables throttling. |
| `WAFEQ_RATE_WINDOW_MS` | `10000` | Rate-limit window in milliseconds. |
| `WAFEQ_MAX_RETRIES` | `3` | Retries on `429` / `5xx` / network errors. |
| `WAFEQ_TIMEOUT_MS` | `30000` | Per-attempt request timeout. |
| `WAFEQ_ALLOW_LOCAL_FILE_UPLOAD` | `false` | Allow upload tools to read this machine's filesystem via `file_path`. See [Security](#security). |
| `WAFEQ_MAX_UPLOAD_BYTES` | `26214400` | Maximum decoded upload size (25 MiB). |

### Too many tools?

251 tools is a lot, and some hosts get slower or less accurate with that many. Narrow
the catalogue without touching code:

```bash
WAFEQ_TOOL_GROUPS=invoices,bills,contacts,payments,reports,accounts,items,tax-rates
```

The two hand-written tools are always available, so nothing becomes unreachable —
anything you filter out can still be called through `wafeq_request`.

## Tool safety categories

Every tool's description opens with a banner, and every tool carries the matching MCP
annotations. Counts are for the bundled spec (251 generated + 2 hand-written = 253).

| Banner | Tools | `readOnlyHint` | `destructiveHint` | What it covers |
| --- | ---: | :---: | :---: | --- |
| 🟢 `READ-ONLY` | 85 | ✅ | ❌ | Every `GET`, plus the account-ledger convenience tool. |
| 🟢 `READ-ONLY · returns a PDF` | 9 | ✅ | ❌ | The PDF downloads: invoice, simplified invoice, credit note, debit note, bill, quote, purchase order, payment, payslip. Returned base64-encoded. |
| 🟢 `READ-ONLY · preview / simulation` | 4 | ✅ | ❌ | Amortization and revenue-recognition previews. `POST`, but documented as writing nothing. |
| 🟡 `WRITE · creates data` | 39 | ❌ | ❌ | Collection creates, both file uploads, and the two conversions (quote→invoice, purchase order→bill). Not idempotent by nature — hence the automatic idempotency key. |
| 🟡 `WRITE · updates data` | 70 | ❌ | ❌ | Every `PUT` and `PATCH`. |
| 🟠 `STATE CHANGE · moves a document in or out of the ledger` | 2 | ❌ | ❌ | Mark expense posted / draft. Reversible — each undoes the other. |
| 🔴 `IRREVERSIBLE · files the document with an external tax authority` | 3 | ❌ | ✅ | Report invoice / credit note / simplified invoice to the tax authority. Leaves your organization and **cannot be recalled**. |
| 🔴 `IRREVERSIBLE · posts the remaining balance to the ledger` | 2 | ❌ | ✅ | End amortization / revenue recognition early. No API undo — run the matching preview first. |
| 🔴 `DESTRUCTIVE · deletes` | 39 | ❌ | ✅ | Every `DELETE`, plus the `wafeq_request` passthrough (its effect can't be known in advance). |
| | **253** | **98** | **44** | |

The three 🔴 groups all set `destructiveHint: true`, so a host that honors annotations
stops and asks before any of them — not just before deletions. Filing an invoice with
a tax authority is at least as consequential as deleting one, and unlike a deletion
it reaches outside your organization.

Print the live catalogue any time, without credentials:

```bash
npm run list-tools
```

## Coverage

| Area | Tools | 🟢 Read | 🟡 Write | 🔴 Irreversible | 🔴 Delete |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Sales & receivables** | 69 | 25 | 31 | 3 | 10 |
| **Purchasing & payables** | 54 | 19 | 27 | 0 | 8 |
| **Banking** | 18 | 6 | 9 | 0 | 3 |
| **Ledger & reporting** | 31 | 19 | 6 | 2 | 4 |
| **Payroll** | 19 | 7 | 9 | 0 | 3 |
| **Master data & dimensions** | 54 | 18 | 27 | 0 | 9 |
| **Files & organization** | 6 | 3 | 2 | 0 | 1 |
| **Escape hatch & convenience** | 2 | 1 | 0 | 0 | 1 |
| **Total** | **253** | **98** | **111** | **5** | **39** |

<sub>"Write" includes the two 🟠 state-change tools. Areas map to Wafeq resources as
follows — Sales: invoices, simplified invoices, quotes, credit notes, payments,
payment requests · Purchasing: bills, purchase orders, debit notes, expenses,
beneficiaries · Banking: bank accounts with their ledger and statement transactions ·
Ledger & reporting: accounts, manual journals, journal line items, the four reports,
tax rates, amortizations, revenue recognitions · Payroll: payslips, employees ·
Master data: contacts, items, units of measure, warehouses, projects, cost centers,
branches, custom fields.</sub>

### Two hand-written tools

Everything above is generated. Two tools are written by hand:

- **`wafeq_account_ledger`** (🟢) — journal line items **with their real transaction
  date**. Wafeq's `/journal-line-items/` rows carry `created_ts` (when the row reached
  Wafeq), which is regularly a different month from the transaction, and no date
  field at all. This tool recovers the date using the endpoint's own
  `date_after`/`date_before` filters, which *do* operate on the transaction date. It
  probes a month at a time and only splits into day queries where rows exist, so quiet
  periods cost one request each; the result reports `requests_made`.
- **`wafeq_request`** (🔴) — the escape hatch: any method, any path, plus query, body
  **and headers**. It is the fallback for anything the bundled spec misses, not the
  primary interface. Categorized destructive because its effect can't be known in
  advance.

## Run from source (stdio, no Docker)

```bash
npm ci
npm run build
```

Then register it with your MCP client. For **Claude Desktop**, add to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wafeq": {
      "command": "node",
      "args": ["/absolute/path/to/Wafeq MCP/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "WAFEQ_API_KEY": "your-key-here"
      }
    }
  }
}
```

For **Claude Code**:

```bash
claude mcp add wafeq --env WAFEQ_API_KEY=your-key-here -- node /absolute/path/to/dist/index.js
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm test` | Run the Vitest suite. |
| `npm run list-tools` | Print the categorized catalogue. Needs no credentials. |
| `npm run start:stdio` | Run over stdio. |
| `npm run start:http` | Run the Streamable HTTP server. |

## Keeping the spec current

Tools are generated from `spec/wafeq-public-api.json` at startup — there is no code
generation step and no hand-written tool list. Drop in a newer OpenAPI document
(JSON or YAML), rebuild, and new endpoints become new tools. See
[`spec/README.md`](./spec/README.md) for where the bundled copy came from and what to
re-check after an update.

Observed-behaviour corrections live in `src/overrides.ts`, keyed by `operationId` and
dated, so an entry whose operation disappears simply stops applying.

## Security

- **Credentials stay server-side.** They are read from the environment and injected
  per request. The model sees tool inputs and API responses, never the key. The
  passthrough tool cannot override the `Authorization` header, and refuses to send
  the credential to any host other than the configured API base.
- **Never commit `.env`.** It is git-ignored, and CI fails if it ever becomes tracked.
  `.env.example` holds placeholders only.
- **Bind to localhost, or set a token.** `docker-compose.yml` publishes on
  `127.0.0.1` only. If you expose the port any further, set `MCP_SHARED_TOKEN` first;
  it is compared in constant time.
- **Local file uploads are off by default.** `WAFEQ_ALLOW_LOCAL_FILE_UPLOAD=false`
  means the server will not read files from its own filesystem. Turning it on lets
  anything that can call the server ask it to read a local path — leave it off unless
  you need it and trust every client. Base64 uploads work either way.
- **Check the organization on `/health`** before the first write. An API key is
  scoped to one organization, and a wrong key fails by writing to the wrong company
  rather than by erroring.
- **The 🔴 tools mean it.** Deletions are permanent, ending a schedule early has no
  API undo, and a tax-authority filing cannot be recalled. Keep host confirmations on
  for anything carrying `destructiveHint`.

See [SECURITY.md](./SECURITY.md) to report a vulnerability.

## Credits & license

MIT — see [LICENSE.md](./LICENSE.md). Built on the
[Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk),
following the same architecture as
[ohneben's LearnWorlds MCP](https://github.com/ohneben/Learnworlds-MCP).
Not affiliated with or endorsed by Wafeq.
