# Commands

Global output is compact AXI text by default. Add `--format json` anywhere. `help`, `--help`, and `help <domain>` return the same structured envelope style.

| Command | Purpose |
|---|---|
| `suazo-axi` | Live local home with executable path, integration counts, and next commands |
| `doctor` | Check Node, CLI availability, safe auth status, and bridge requirements |
| `integrations list [--fields ...]` | Show the integration catalog |
| `files list [path] [--root path] [--limit N] [--full]` | List a directory |
| `files read <path> [--root path] [--max-chars N] [--full]` | Read bounded UTF-8 content |
| `files find <query> [path] [--root path] [--limit N]` | Bounded filename search |
| `knowledge status [--graph <graph.json>]` | Check Graphify availability/version and whether the selected graph exists |
| `knowledge query --question <text> [--graph <graph.json>] [--budget N]` | Run a bounded Graphify knowledge query |
| `knowledge path --from <node> --to <node> [--graph <graph.json>]` | Return the shortest Graphify path between two nodes |
| `knowledge affected --node <node> [--graph <graph.json>] [--depth N]` | Return nodes affected within the selected depth |
| `github status` | Run the safe `gh auth status` check without exposing account text |
| `github repo view [--repo owner/name]` | Return compact repository data |
| `github pr list [--repo owner/name] [--limit N]` | Return number, title, state, and update time |
| `github pr view --number N [--repo owner/name]` | Return compact pull request details |
| `github pr checks --number N [--repo owner/name]` | Return pull request check status metadata |
| `github pr reviews --number N [--repo owner/name] [--limit N]` | Return compact pull request reviews |
| `github issue list [--repo owner/name] [--limit N]` | Return number, title, state, and update time |
| `github run list [--repo owner/name] [--limit N]` | Return compact workflow-run summaries |
| `github run view --id N [--repo owner/name]` | Return compact workflow-run details |
| `github run failed --id N [--repo owner/name]` | Return failed job and step metadata without raw logs |
| `vercel deployment list [project] [--limit N]` | Return compact deployments across the active scope or one project |
| `vercel deployment view <deployment-reference>` | Return compact deployment details using the ID or hostname returned by list |
| `supabase status [--workdir path]` | Return whitelisted local service endpoints without keys or database credentials |
| `supabase projects list [--limit N]` | Return compact hosted project metadata for the logged-in CLI user |
| `notion status` | Check `ntn` availability and authentication, returning only bot ID and workspace name |
| `notion search --query <q> [--limit N]` | Search Notion pages and return compact page metadata |
| `notion page view --id <uuid>` | Return compact metadata for one Notion page |
| `firecrawl status` | Check Firecrawl authentication and remaining credits |
| `firecrawl search --query <q> [--limit N]` | Return compact web search results without scraped content |
| `firecrawl map --url <u> [--limit N]` | Return mapped HTTP/HTTPS URLs without crawling or scraping content |
| `higgsfield status` | Check Higgsfield authentication, plan, and remaining credits without email |
| `higgsfield model list [--kind image\|video\|audio\|text] [--limit N]` | Return compact read-only model metadata |
| `higgsfield generation list [--limit N]` | Return compact existing-generation metadata |
| `higgsfield generation view --id <id>` | Return compact metadata for one existing generation |
| `docker status` | Report Docker CLI availability and the running, stopped, or unreachable daemon state |
| `docker container list [--all] [--limit N]` | Return compact existing-container metadata; `--all` includes stopped containers |
| `docker container view --id <id>` | Return whitelisted metadata for one existing container without environment, command, label, or mount details |
| `docker image list [--limit N]` | Return compact local image metadata |
| `docker compose list` | Return existing Compose project metadata with config basenames only |
| `codex status` | Check Codex CLI login without spending a model run or exposing account text |
| `codex run --prompt-file <path> --cwd <dir> [--timeout-ms N] [--effort low\|medium\|high] [--mode read-only]` | Run the global lean wrapper inside a forced read-only sandbox and return only its final text |

Limits are positive integers.
GitHub list and review limits default to 20 and are capped at 100; filesystem limits are capped at 1000.
Notion and Firecrawl search limits default to 10; Firecrawl map defaults to 100; Higgsfield lists default to 10. All provider limits are capped at 100.
Docker container and image limits default to 20 and are capped at 100. Docker container IDs use 1â€“128 letters, numbers, dots, underscores, or hyphens, must start with a letter or number, and cannot inject options.
Codex timeouts default to 300000 milliseconds and must be from 1000 through 1800000 milliseconds.
Knowledge query budgets default to 300 and must be integers from 50 through 2000.
Affected depths default to 2 and must be integers from 1 through 6.
Repo names must be `owner/name` and cannot start with an option-shaped owner.
Pull request numbers and workflow-run IDs must be positive integers.
Notion page IDs are 32 hexadecimal UUIDs with or without hyphens. Firecrawl URLs must be HTTP/HTTPS and at most 2048 characters. Provider queries are non-empty, contain no NUL, and are capped at 512 characters. Higgsfield generation IDs use 1–128 letters, numbers, underscores, or hyphens and cannot be option-shaped.
`files list --full` returns the complete directory listing.
Default file reads open a verified handle and consume only a bounded UTF-8 byte window; `files read --full` deliberately reads complete content and can use memory proportional to file size.
Empty lists set `meta.empty: true` and return an explicit empty array.

`codex run` requires an existing prompt file and cwd, resolves both paths before invocation, never reads prompt contents, and never adds either path to output.
The only accepted mode is `read-only`, and the adapter always passes it explicitly to the wrapper.

Knowledge graph paths default to `graphify-out/graph.json` relative to the current working directory.
Query, path, and affected require an existing regular file and pass its real path only to Graphify; AXI results and sanitized provider errors never expose that path.
`knowledge status` remains successful when the graph is missing.
Successful traversal text is trimmed, bounded to 256 KiB of combined provider output, and rejected when empty.
The knowledge domain intentionally exposes no build, refresh, update, or watch command.

The Notion, Firecrawl, and Higgsfield adapters inherit their existing CLI sessions and expose no login/configuration command. Firecrawl intentionally has no scrape, crawl, agent, interact, parse, monitor, or browser operation. Higgsfield intentionally has no generation-creation or other mutating operation. Provider list and view responses are normalized into whitelisted fields; raw JSON, account email, keys, tokens, and diagnostics are discarded.

Docker has no AXI login command: authority comes exclusively from the local daemon socket or named pipe already available to Docker CLI. `docker status` succeeds for `running`, `stopped`, `unreachable`, and `cli-missing` environment states. Doctor reports the exact stopped case as `daemon-stopped`; an unresponsive engine is `degraded`, not stopped. Every Docker subprocess is bounded to 10 seconds for status or 15 seconds for reads. List timeouts return retryable `docker-timeout`; nonzero listing exits return `docker-error`. AXI exposes none of Docker's run, exec, lifecycle, build, transfer, authentication, pruning, context-changing, swarm, network/volume mutation, or Compose up/down operations.

No command accepts raw passthrough arguments. Provider calls use fixed argument arrays, a timeout, a combined output cap, and redacted structured failures. stdout contains only the result envelope; unexpected launcher diagnostics go to stderr.

`github run failed` deliberately returns only normalized failed job and step metadata, not raw logs, to preserve the credential-nonprinting contract.

The integration catalog keeps a compact default field set. Use `integrations list --fields id,capabilities` to inspect the declared resource/action capabilities. Catalog status is lifecycle state; current command availability is reported only by `doctor`.
