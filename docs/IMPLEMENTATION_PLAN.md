# Production implementation plan

This plan advances one read-only adapter at a time while preserving the dependency-free Node ESM core. A catalog capability describes the intended contract; only a service with lifecycle status `implemented` has callable operations.

## Lifecycle and runtime vocabulary

- `implemented`: the listed AXI operations exist, are tested, and are exposed by the CLI.
- `planned`: an adapter contract is intended, but no callable AXI operation exists yet.
- `host-bridge-required`: progress is blocked until a supported host-to-CLI bridge exists.
- `unconfigured`: a provider/backend decision and user-approved setup are still required.
- `detected` / `not-detected`: runtime-only `doctor` results showing whether an executable is on `PATH`; neither implies authentication or implementation.
- `blocked` / `decision-needed`: planning labels, not manifest statuses. They identify an unresolved dependency or approval gate.

## Service matrix

| Service | Current transport and auth owner | Preferred adapter/backend | Target increment | Read/mutation scope | Acceptance evidence | Rollback |
|---|---|---|---|---|---|---|
| Files | Node built-ins; OS permissions | Existing native adapter | Maintain Phase 1 | List/read/find only; no mutation | Offline traversal, symlink, bounds, empty-state, envelope tests | Remove new operation routing; retain current adapter |
| GitHub | `gh`; GitHub CLI owns auth | `gh-axi` when approved/available, with `gh` fallback | Maintain expanded read surface, then backend selection | Status, repo view, PR list/view/checks/reviews, issue list, and workflow-run list/view/failed-summary; no mutation or raw log retrieval | Offline argv, routing, normalization, bounds, redaction, and envelope tests; safe auth probe | Remove expanded routes independently or select `gh` fallback without moving credentials |
| Outlook Email | Native Codex connector; host owns auth | Supported host bridge to native connector | Blocked: bridge contract first | Message list/read/search; no send/update/delete | Mock bridge conformance plus approved host integration evidence | Disable bridge registration; no auth export |
| Notion | `ntn` CLI; CLI owns auth | Narrow `ntn` adapter | Page search/read increment | Read-only; no page mutation | Offline argv/normalization tests, then user-approved authenticated smoke test | Remove routing and retain planned manifest |
| Vercel | Vercel CLI or local secure wrapper; CLI owns auth | Implemented narrow Vercel CLI adapter | Maintain deployment list/view | Read-only; no deploy/promote/delete | Shared harness, offline fixtures, safe auth probe, authenticated list-to-view smoke | Remove Vercel routing and restore its manifest to planned |
| Supabase | Official Supabase CLI; CLI owns auth | Implemented narrow Supabase CLI adapter | Maintain local status and hosted project list | Read-only; no init/start/reset/link/push or remote mutation | Shared harness, secret-whitelist fixtures, login classification, controlled local and authenticated remote smokes | Remove Supabase routing and restore its manifest to planned |
| Codex | Global Codex CLI login; CLI owns auth | Implemented global lean wrapper adapter | Maintain status and bounded run | Read-only sandbox only; no tooling, full output, apply, or writable modes | Exact argv, path, bounds, redaction, login classification, router, doctor, and controlled read-only smoke tests | Remove Codex routing and restore its manifest to planned |
| Firecrawl | Firecrawl CLI; CLI owns auth | Narrow Firecrawl CLI adapter | Search first, scrape second | Read-only retrieval; no crawl job mutation | Bounded-output fixtures, redaction checks, approved smoke test | Disable newest action independently |
| Higgsfield | Higgsfield CLI; CLI owns auth | Narrow Higgsfield CLI adapter | Generation list/view metadata | Read-only; generation remains out of scope | Offline fixtures and approved smoke test without generation | Remove routing and retain planned manifest |
| Stitch | MCP in host; host owns auth | Supported host bridge | Blocked: bridge contract first | Design list/view only | Mock bridge contract and approved host evidence | Disable bridge registration |
| Hermes | MCP in host; host owns auth | Supported host bridge | Blocked: bridge contract first | Agent-run list/view only; no run creation | Mock bridge contract and approved host evidence | Disable bridge registration |
| Browser | Plugin/native connector; host owns auth | Prefer `chrome-devtools-axi` when later installed and approved | Decision gate, then inspect/capture | Read-only inspection/capture; no clicks/forms/navigation mutations | Deterministic fixtures, origin allowlist tests, approved local smoke test | Fall back to no browser adapter |
| Calendar | No provider selected | Provider chosen by user | Decision-needed before any code | Event list/view first; no create/update/delete | Provider-specific contract tests and user-approved auth smoke test | Remove adapter; provider retains auth/data |

## Decision gates

Native Codex connectors cannot currently be invoked by a standalone CLI without a supported host bridge. Outlook Email, Stitch, Hermes, and host-native browser access must remain `host-bridge-required`; this project must not promise or attempt authentication export.

Calendar requires choosing a provider, installing its supported transport if needed, and authenticating it. Those are user-controlled changes and require explicit approval before implementation or setup.

Browser work should prefer `chrome-devtools-axi` if it is later installed and approved. GitHub may prefer `gh-axi` later, but the existing `gh` transport remains the required fallback until the alternative passes the same contract suite.

## Shippable increments

1. Preserve Phase 1 contracts: manifest/schema alignment, safe doctor detection, sanitized errors, and offline regression coverage.
2. Add a reusable adapter conformance harness covering envelopes, fixed argv, normalization, empty states, timeouts, output caps, and redaction.
3. Ship Vercel deployment list/view as one adapter increment.
4. Ship Supabase local status and hosted project list as one adapter increment.
5. Maintain GitHub pull request and workflow-run reads, including failed job/step metadata without raw workflow logs, and pass them through the shared conformance harness.
6. Maintain Codex through the lean wrapper with explicit cwd, prompt-file, timeout, effort, and forced read-only mode.
7. Ship Notion page search/read as one adapter increment.
8. Ship Firecrawl search, then scrape as separate increments because scrape payload and output limits differ.
9. Ship Higgsfield list/view metadata without generation.
10. Evaluate `gh-axi` behind ordered backend selection while retaining `gh` fallback.
11. After explicit approval, evaluate and install `chrome-devtools-axi`, then ship browser inspect/capture.
12. Define a versioned host-bridge protocol before adding Outlook Email, Stitch, or Hermes.
13. After the user chooses and approves a calendar provider and authentication path, ship event list/view.

Each increment must be independently releasable and reversible. No increment may silently broaden read scope or add mutation.

## Release gates

### Contract and conformance

Every manifest must match the schema, every declared implemented capability must route to an operation, and every operation must return the stable envelope in compact and JSON formats. Provider normalization, empty states, invalid flags, exit categories, and fallback ordering need offline tests before an authenticated smoke test.

### Security

Subprocesses keep `shell: false`, ignored stdin, fixed argv, timeouts, byte caps, bounded process-tree termination, and discarded raw provider errors.
Executable detection uses only filesystem `PATH`/`PATHEXT` resolution and never executes a provider or reads auth.
Codex runs force the lean wrapper to use `-Sandbox read-only` and reject every writable or apply mode before provider invocation.
Files remain root-constrained, re-check opened paths, and bound default reads; a malicious process continuously rewriting the authorized tree remains an explicit residual local threat.
Logs and error command labels exclude path, query, content, credentials, environment values, and raw provider payloads.
Mutations remain blocked until a separately reviewed preview/`--apply`/idempotency contract exists.

### Observability

Record only stable command label, adapter/backend, duration, exit category, correlation identifier, counts, and truncation. Never record content arguments or auth output. A new adapter must provide enough local evidence to distinguish unavailable, unauthenticated, degraded, timeout, invalid response, and empty success.

### Versioning and rollback

The `axi` contract version governs envelope compatibility; package semantic versioning governs releases. Additive optional fields can be minor changes, while default-shape removals or semantic changes require a contract-major change. Rollback disables the newest route or backend selection and restores the preceding adapter. Authentication and external data stay owned by the provider, so rollback never copies or rewrites credentials or content.
