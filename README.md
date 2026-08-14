# suazo-axi

`suazo-axi` is a dependency-free Node.js ESM CLI that puts a compact, stable AXI-first interface over existing authenticated transports. It is a thin local broker: it neither stores credentials nor replaces provider backends.

Implemented adapters cover local files with Node built-ins, installed Graphify knowledge-map traversal, GitHub repository, pull request, issue, and workflow-run reads through `gh`, Vercel deployment list/view, Supabase local status/project list, read-only Codex runs through the global lean wrapper, Notion page search/view through `ntn`, Firecrawl search/map, Higgsfield model and generation metadata, and Docker daemon/container/image/Compose metadata through the installed Docker CLI.
Static catalog statuses are durable lifecycle facts: `implemented`, `planned`, `host-bridge-required`, or `unconfigured`.
Point-in-time readiness appears only in `doctor`; `daemon-stopped` means the Docker CLI is usable while its local engine is stopped.

## Use

Node.js 20 or newer is required. No package installation is needed for direct use.

```text
node bin/suazo-axi.js
node bin/suazo-axi.js integrations list --format json
node bin/suazo-axi.js files list . --root . --limit 10
node bin/suazo-axi.js knowledge query --question "What depends on the CLI?" --budget 300
node bin/suazo-axi.js github pr list --repo owner/name --limit 20
node bin/suazo-axi.js github pr checks --repo owner/name --number 42
node bin/suazo-axi.js github run failed --repo owner/name --id 123456789
node bin/suazo-axi.js notion search --query "release notes" --limit 10
node bin/suazo-axi.js firecrawl map --url https://example.com --limit 100
node bin/suazo-axi.js higgsfield generation list --limit 10
node bin/suazo-axi.js docker status
node bin/suazo-axi.js docker container list --all --limit 20
node bin/suazo-axi.js codex status
node bin/suazo-axi.js codex run --prompt-file task.md --cwd . --mode read-only
```

The stable shape is `suazo-axi <domain> <resource> <action> [flags]`. Every result has `axi`, `ok`, `command`, `data`, `meta`, and `help`; errors also have a structured `error`. Exit code `0` means success, `1` means an operational/provider failure, and `2` means invalid input.

Compact AXI text is the default. It is an intentionally small deterministic encoding, not a claim of full TOON compatibility. `--format json` is the machine-consumer escape hatch; an official TOON encoder can later be added at the formatter seam.

See [commands](docs/COMMANDS.md), [architecture](docs/ARCHITECTURE.md), [authentication](docs/AUTHENTICATION.md), and the [production implementation plan](docs/IMPLEMENTATION_PLAN.md). Run tests with `npm.cmd test` on Windows or `npm test` elsewhere.

## Safety

Implemented adapters are read-only.
Files are constrained to `--root`, symlink escapes and traversal are rejected, default reads consume a bounded byte window, and recursive search is bounded.
`files read --full` is an explicit, potentially unbounded request.
Codex runs require existing prompt and workspace paths and always pass `-Sandbox read-only` to the approved lean wrapper.
Knowledge traversal requires an existing regular graph file, defaults to `graphify-out/graph.json`, and never returns its resolved path.
AXI exposes no Graphify build, refresh, update, or watch operation.
Provider commands use fixed argument arrays with no shell, timeouts, output caps, process-tree termination, and hidden Windows process windows.
Notion exposes only bot/workspace status and page search/view; Firecrawl exposes only status, search, and map; Higgsfield exposes only status plus model and generation metadata. Scrape, crawl, browser interaction, generation creation, and every provider mutation remain unavailable.
Docker exposes only status and existing container, image, and Compose project metadata. It cannot run, execute, start, stop, restart, remove, build, pull, push, copy, prune, log in, or invoke any other Docker mutation; container inspection discards environment values, commands, entrypoints, labels, and host mount paths.
The broker never directly prints credentials, prompt files, provider diagnostics, or environment values.
`github run failed` returns normalized failed job and step metadata, never raw workflow logs.
A malicious local process concurrently rewriting the allowed filesystem tree is outside the complete cross-platform guarantee; see the threat model.
