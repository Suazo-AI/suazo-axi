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
| `codex status` | Check Codex CLI login without spending a model run or exposing account text |
| `codex run --prompt-file <path> --cwd <dir> [--timeout-ms N] [--effort low\|medium\|high] [--mode read-only]` | Run the global lean wrapper inside a forced read-only sandbox and return only its final text |

Limits are positive integers.
GitHub list and review limits default to 20 and are capped at 100; filesystem limits are capped at 1000.
Codex timeouts default to 300000 milliseconds and must be from 1000 through 1800000 milliseconds.
Repo names must be `owner/name` and cannot start with an option-shaped owner.
Pull request numbers and workflow-run IDs must be positive integers.
`files list --full` returns the complete directory listing.
Default file reads open a verified handle and consume only a bounded UTF-8 byte window; `files read --full` deliberately reads complete content and can use memory proportional to file size.
Empty lists set `meta.empty: true` and return an explicit empty array.

`codex run` requires an existing prompt file and cwd, resolves both paths before invocation, never reads prompt contents, and never adds either path to output.
The only accepted mode is `read-only`, and the adapter always passes it explicitly to the wrapper.

No command accepts raw passthrough arguments. Provider calls use fixed argument arrays, a timeout, a combined output cap, and redacted structured failures. stdout contains only the result envelope; unexpected launcher diagnostics go to stderr.

`github run failed` deliberately returns only normalized failed job and step metadata, not raw logs, to preserve the credential-nonprinting contract.

The integration catalog keeps a compact default field set. Use `integrations list --fields id,capabilities` to inspect the declared resource/action capabilities. Catalog status is lifecycle state; current command availability is reported only by `doctor`.
