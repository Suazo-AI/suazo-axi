# Authentication

`suazo-axi` inherits authentication from the selected transport. It is not a credential vault: it does not ask for tokens, copy auth files, inspect secret configuration, or store environment values.

GitHub Phase 1 invokes the existing `gh` binary. Configure and manage that login with GitHub CLI outside this repository. `github status` and `doctor` consume only the process exit status of `gh auth status`; account names, host details, tokens, and stderr are discarded.

Vercel inherits the existing Vercel CLI session. On Windows, `suazo-axi` prefers the local `vercel-secure` wrapper when present; that wrapper retrieves the credential from Windows Credential Manager and exposes it only to the child Vercel process. No token value is returned, logged, copied, or stored by this project. `doctor` consumes only whether the safe `whoami --json` probe succeeded.

Host-only native connectors and MCP transports report `host-bridge-required`, not disconnected, because a standalone process cannot truthfully inspect host session state. Planned CLI adapters retain `planned` in the catalog; `doctor` may report their executables as `detected` or `not-detected`, which is not an authentication promise. Calendar remains `unconfigured`.

When adding an adapter, use the provider's established authentication mechanism, pass only non-secret arguments, cap outputs, and normalize errors without provider text. Never put credentials in a manifest, log, fixture, or repository file.
