# Production implementation plan

This plan advances one read-only adapter at a time while preserving the dependency-free Node ESM core. A catalog capability describes the intended contract; only a service with lifecycle status `implemented` has callable operations.

## Lifecycle and runtime vocabulary

- `implemented`: the listed AXI operations exist, are tested, and are exposed by the CLI.
- `planned`: an adapter contract is intended, but no callable AXI operation exists yet.
- `host-bridge-required`: progress is blocked until a supported host-to-CLI bridge exists.
- `unconfigured`: a provider/backend decision and user-approved setup are still required.
- `detected` / `not-detected`: runtime-only `doctor` results for the planned Hermes executable on `PATH`; neither implies authentication or implementation.
- `daemon-stopped`: runtime-only `doctor` result for an available Docker CLI whose local engine explicitly reports `Server: null`; an unresponsive engine is instead `degraded`.
- `blocked` / `decision-needed`: planning labels, not manifest statuses. They identify an unresolved dependency or approval gate.

## Service matrix

| Service | Current transport and auth owner | Preferred adapter/backend | Target increment | Read/mutation scope | Acceptance evidence | Rollback |
|---|---|---|---|---|---|---|
| Files | Node built-ins; OS permissions | Existing native adapter | Maintain Phase 1 | List/read/find only; no mutation | Offline traversal, symlink, bounds, empty-state, envelope tests | Remove new operation routing; retain current adapter |
| Knowledge | Installed Graphify CLI; no AXI auth | Implemented narrow Graphify adapter | Maintain Phase 5 | Status/query/path/affected only; no graph build/update/watch | Exact argv, real-file validation, bounds, redaction, doctor, and CLI tests | Remove knowledge routing and restore its manifest entry |
| Docker | Installed Docker CLI; local daemon socket or named pipe owns authority | Implemented narrow Docker adapter | Maintain Phase 9 | Status and existing container/image/Compose metadata only; no lifecycle, build, transfer, auth, context, or other mutation operations | Offline argv, NDJSON, timeout, whitelist, secret-redaction, doctor, and CLI tests | Remove Docker routing and its manifest entry without changing Docker configuration |
| GitHub | `gh`; GitHub CLI owns auth | `gh-axi` when approved/available, with `gh` fallback | Maintain expanded read surface, then backend selection | Status, repo view, PR list/view/checks/reviews, issue list, and workflow-run list/view/failed-summary; no mutation or raw log retrieval | Offline argv, routing, normalization, bounds, redaction, and envelope tests; safe auth probe | Remove expanded routes independently or select `gh` fallback without moving credentials |
| Outlook Email | Native Codex connector; host owns auth | Supported host bridge to native connector | Blocked: bridge contract first | Message list/read/search; no send/update/delete | Mock bridge conformance plus approved host integration evidence | Disable bridge registration; no auth export |
| Notion | `ntn` CLI; CLI owns auth | Implemented narrow `ntn` adapter | Maintain Phase 6 status and page search/view | Read-only; no page mutation | Exact argv, normalization, invalid-shape, status, transport, router, and approved smoke evidence | Remove Notion routing and restore its manifest to planned |
| Vercel | Vercel CLI or local secure wrapper; CLI owns auth | Implemented narrow Vercel CLI adapter | Maintain deployment list/view | Read-only; no deploy/promote/delete | Shared harness, offline fixtures, safe auth probe, authenticated list-to-view smoke | Remove Vercel routing and restore its manifest to planned |
| Supabase | Official Supabase CLI; CLI owns auth | Implemented narrow Supabase CLI adapter | Maintain local status and hosted project list | Read-only; no init/start/reset/link/push or remote mutation | Shared harness, secret-whitelist fixtures, login classification, controlled local and authenticated remote smokes | Remove Supabase routing and restore its manifest to planned |
| Codex | Global Codex CLI login; CLI owns auth | Implemented global lean wrapper adapter | Maintain status and bounded run | Read-only sandbox only; no tooling, full output, apply, or writable modes | Exact argv, path, bounds, redaction, login classification, router, doctor, and controlled read-only smoke tests | Remove Codex routing and restore its manifest to planned |
| Firecrawl | Firecrawl CLI; CLI owns auth | Implemented narrow Firecrawl CLI adapter | Maintain Phase 7 status, search, and map | Read-only URL metadata; no scrape/crawl/agent/interact/parse/monitor | Shape variants, fixed argv, redaction, bounds, router, doctor, and approved smoke evidence | Remove Firecrawl routing and restore its manifest to planned |
| Higgsfield | Higgsfield CLI; CLI owns auth | Implemented narrow Higgsfield CLI adapter | Maintain Phase 8 status, model list, and generation list/view metadata | Read-only; generation creation remains out of scope | Offline normalization, argv, transport, redaction, router, doctor, and approved smoke evidence | Remove Higgsfield routing and restore its manifest to planned |
| Stitch | MCP in host; host owns auth | Supported host bridge | Blocked: bridge contract first | Design list/view only | Mock bridge contract and approved host evidence | Disable bridge registration |
| Hermes | `hermes-cli`; CLI owns auth | Planned narrow Hermes CLI adapter | Define read-only agent-run list/view | Agent-run list/view only; no run creation | Executable detection, then offline contract tests and approved smoke evidence | Retain planned catalog entry and remove routing if added |
| Browser | Plugin/native connector; host owns auth | Prefer `chrome-devtools-axi` when later installed and approved | Decision gate, then inspect/capture | Read-only inspection/capture; no clicks/forms/navigation mutations | Deterministic fixtures, origin allowlist tests, approved local smoke test | Fall back to no browser adapter |
| Calendar | No provider selected | Provider chosen by user | Decision-needed before any code | Event list/view first; no create/update/delete | Provider-specific contract tests and user-approved auth smoke test | Remove adapter; provider retains auth/data |

## Decision gates

Native Codex connectors cannot currently be invoked by a standalone CLI without a supported host bridge. Outlook Email, Stitch, and host-native browser access must remain `host-bridge-required`; this project must not promise or attempt authentication export. Hermes is instead planned over `hermes-cli`, and executable detection alone does not imply a callable adapter or authentication.

Calendar requires choosing a provider, installing its supported transport if needed, and authenticating it. Those are user-controlled changes and require explicit approval before implementation or setup.

Browser work should prefer `chrome-devtools-axi` if it is later installed and approved. GitHub may prefer `gh-axi` later, but the existing `gh` transport remains the required fallback until the alternative passes the same contract suite.

## Shippable increments

1. Preserve Phase 1 contracts: manifest/schema alignment, safe doctor detection, sanitized errors, and offline regression coverage.
2. Add a reusable adapter conformance harness covering envelopes, fixed argv, normalization, empty states, timeouts, output caps, and redaction.
3. Ship Vercel deployment list/view as one adapter increment.
4. Ship Supabase local status and hosted project list as one adapter increment.
5. Maintain GitHub pull request and workflow-run reads, including failed job/step metadata without raw workflow logs, and pass them through the shared conformance harness.
6. Maintain Codex through the lean wrapper with explicit cwd, prompt-file, timeout, effort, and forced read-only mode.
7. Maintain Graphify as a read-only local knowledge transport with bounded status/query/path/affected operations.
8. Maintain Notion Phase 6 status and page search/view without page mutation.
9. Maintain Firecrawl Phase 7 status, search, and map; scrape, crawl, agent, interact, parse, and monitor remain excluded.
10. Maintain Higgsfield Phase 8 status, model list, and generation list/view metadata without generation creation.
11. Evaluate `gh-axi` behind ordered backend selection while retaining `gh` fallback.
12. After explicit approval, evaluate and install `chrome-devtools-axi`, then ship browser inspect/capture.
13. Define a versioned host-bridge protocol before adding Outlook Email or Stitch; design Hermes separately over its planned CLI transport.
14. After the user chooses and approves a calendar provider and authentication path, ship event list/view.

Each increment must be independently releasable and reversible. No increment may silently broaden read scope or add mutation.

## Release gates

### Contract and conformance

Every manifest must match the schema, every declared implemented capability must route to an operation, and every operation must return the stable envelope in compact and JSON formats. Provider normalization, empty states, invalid flags, exit categories, and fallback ordering need offline tests before an authenticated smoke test.

### Security

Subprocesses keep `shell: false`, ignored stdin, fixed argv, timeouts, byte caps, bounded process-tree termination, and discarded raw provider errors.
Executable detection uses only filesystem `PATH`/`PATHEXT` resolution and never executes a provider or reads auth.
Codex runs force the lean wrapper to use `-Sandbox read-only` and reject every writable or apply mode before provider invocation.
Graphify traversals require a real regular graph file, keep questions and nodes in individual argv values, and never return graph paths, raw provider stderr, or raw provider errors.
Graph-building and refresh operations remain outside AXI.
Notion page operations, Firecrawl search/map, and Higgsfield metadata operations remain fixed read-only surfaces. Firecrawl content retrieval and browser/job operations are excluded; Higgsfield generation creation is excluded; status normalization discards email, credentials, and raw account payloads.
Files remain root-constrained, re-check opened paths, and bound default reads; a malicious process continuously rewriting the authorized tree remains an explicit residual local threat.
Logs and error command labels exclude path, query, content, credentials, environment values, and raw provider payloads.
Mutations remain blocked until a separately reviewed preview/`--apply`/idempotency contract exists.

### Observability

Record only stable command label, adapter/backend, duration, exit category, correlation identifier, counts, and truncation. Never record content arguments or auth output. A new adapter must provide enough local evidence to distinguish unavailable, unauthenticated, degraded, timeout, invalid response, and empty success.

### Versioning and rollback

The `axi` contract version governs envelope compatibility; package semantic versioning governs releases. Additive optional fields can be minor changes, while default-shape removals or semantic changes require a contract-major change. Rollback disables the newest route or backend selection and restores the preceding adapter. Authentication and external data stay owned by the provider, so rollback never copies or rewrites credentials or content.
