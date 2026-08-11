# Roadmap

## Implemented in Phase 1

- Stable envelope, compact AXI subset, JSON format, help, dashboard, and doctor
- Root-constrained local list/read/find using Node built-ins
- GitHub status, repository view, pull request list, and issue list through `gh`
- Vercel deployment list and view through the authenticated Vercel CLI

## Planned CLI adapters

- Notion via `ntn`, Firecrawl CLI, and Higgsfield CLI

Their durable catalog status is `planned`. Runtime executable detection can change, is reported only by `doctor`, and does not mean the adapter or authentication is implemented.

## Planned host bridges

- Outlook Email native connector
- Stitch MCP and Hermes MCP
- Browser plugin/native connector, with optional `chrome-devtools-axi` preference

Standalone doctor reports these as `host-bridge-required` rather than disconnected.

## Unconfigured and future

- Calendar is a target domain and currently unconfigured.
- Optional `gh-axi` backend selection and an official TOON encoder seam
- Content-safe observability, adapter conformance tooling, and an optional one-tool MCP facade
- Mutations only after plan/apply, `--apply`, and idempotency support exist
