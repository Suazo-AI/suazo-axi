# Roadmap

## Implemented

- Stable envelope, compact AXI subset, JSON format, help, dashboard, and doctor
- Root-constrained local list/read/find using Node built-ins
- Graphify status, query, path, and affected traversal through the installed CLI, with no graph mutation operations
- GitHub status, repository view, pull request list/view/checks/reviews, issue list, and workflow-run list/view/failed-summary through `gh`
- Vercel Phase 2 deployment list and view through the authenticated Vercel CLI
- Supabase Phase 3 local status and hosted project list through the official CLI
- Codex Phase 4 status and bounded agent runs through the global lean wrapper with a forced read-only sandbox
- Notion Phase 6 authentication status and page search/view through `ntn`
- Firecrawl Phase 7 authentication status, web search, and site map through Firecrawl CLI
- Higgsfield Phase 8 authentication status, model list, and generation list/view metadata through Higgsfield CLI
- Docker Phase 9 daemon status, container list/view, image list, and Compose project list through Docker CLI

## Planned CLI adapter

- Hermes via `hermes-cli`

Its durable catalog status is `planned`. Runtime executable detection can change, is reported only by `doctor`, and does not mean the adapter or authentication is implemented.

## Planned host bridges

- Outlook Email native connector
- Stitch MCP
- Browser plugin/native connector, with optional `chrome-devtools-axi` preference

Standalone doctor reports these as `host-bridge-required` rather than disconnected. Hermes is outside this group and reports only `detected` or `not-detected` until its CLI adapter is implemented.

Docker is outside the authentication and host-bridge groups. Its runtime status is `ready` when the engine responds, `daemon-stopped` when the CLI reports `Server: null`, `degraded` when the engine pipe is present but unreachable, and `unavailable` only when the CLI is missing.

## Unconfigured and future

- Calendar is a target domain and currently unconfigured.
- Optional `gh-axi` backend selection and an official TOON encoder seam
- Broader adapter conformance tooling, content-safe observability, and an optional one-tool MCP facade
- Mutations only after plan/apply, `--apply`, and idempotency support exist
