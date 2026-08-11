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
| `github issue list [--repo owner/name] [--limit N]` | Return number, title, state, and update time |
| `vercel deployment list [project] [--limit N]` | Return compact deployments across the active scope or one project |
| `vercel deployment view <deployment-reference>` | Return compact deployment details using the ID or hostname returned by list |
| `supabase status [--workdir path]` | Return whitelisted local service endpoints without keys or database credentials |
| `supabase projects list [--limit N]` | Return compact hosted project metadata for the logged-in CLI user |

Limits are positive integers. GitHub list limits are capped at 100 and filesystem limits at 1000. Repo names must be `owner/name` and cannot start with an option-shaped owner. `files list --full` returns the complete directory listing. Default file reads open a verified handle and consume only a bounded UTF-8 byte window; `files read --full` deliberately reads complete content and can use memory proportional to file size. Empty lists set `meta.empty: true` and return an explicit empty array.

No command accepts raw passthrough arguments. Provider calls use fixed argument arrays, a timeout, a combined output cap, and redacted structured failures. stdout contains only the result envelope; unexpected launcher diagnostics go to stderr.

The integration catalog keeps a compact default field set. Use `integrations list --fields id,capabilities` to inspect the declared resource/action capabilities. Catalog status is lifecycle state; current command availability is reported only by `doctor`.
