# Security Policy

## Supported Versions

This project tracks the latest commit on the `main` branch. Security fixes land
there — please make sure you are running the most recent version before reporting
an issue.

| Version | Supported |
| ------- | :-------: |
| `main` (latest) | ✅ |
| older commits   | ❌ |

## Reporting a Vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub:

1. Open this repository's [**Security** tab](../../security).
2. Click [**Report a vulnerability**](../../security/advisories/new) to start a
   private security advisory.

> If the "Report a vulnerability" button isn't visible, a maintainer needs to enable
> **Private vulnerability reporting** under **Settings → Security**.

Please include a description of the issue and its impact, steps to reproduce, and any
suggested remediation. You can expect an initial response within a few days.

## Handling credentials

This server holds a Wafeq API key or OAuth2 token that can read and write a real set
of books. Treat it accordingly:

- Keep it in `.env` (git-ignored) or your platform's secret store. Never commit it.
- The credential is injected into outgoing requests server-side. It is never included
  in a tool description, tool input, or tool result, so the model never sees it.
- The `wafeq_request` passthrough cannot override the `Authorization` header and
  refuses to send the credential to any host other than the configured API base.
- Rotate the key in Wafeq (Settings → Developer → API keys) if it may have leaked.

## Exposure

- `docker-compose.yml` publishes on `127.0.0.1` only.
- If you expose the port further, set `MCP_SHARED_TOKEN` first. It is required on the
  `/mcp` endpoint and compared in constant time.
- `/health` reports the connected organization's name and id. That is deliberate — it
  is how you catch a key pointed at the wrong tenant — but it means `/health` should
  not be public either.
- `WAFEQ_ALLOW_LOCAL_FILE_UPLOAD` is off by default. Turning it on lets any client
  that can reach the server ask it to read a file from the server's own filesystem.

## Scope

In scope: credential leakage, authentication bypass on the HTTP endpoint, request
forgery through the passthrough tool, and anything that lets a tool call reach a
host other than the configured Wafeq API.

Out of scope: vulnerabilities in the Wafeq API itself (report those to Wafeq), and
the inherent risk of granting an LLM write access to your accounting data — that is
what the safety categories and host confirmations are for.
