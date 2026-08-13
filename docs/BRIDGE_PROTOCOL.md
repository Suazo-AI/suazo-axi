# Host bridge protocol

Draft, version `0.1`. Nothing in the catalog uses it yet; it exists so `host-bridge-required` services stop being blocked on an undefined contract.

The implemented adapters all share one transport shape: spawn a CLI with a fixed argv and parse JSON from stdout (`src/core/cli-provider.js`). MCP servers and host-native connectors do not fit that shape, so this defines the second transport class. `src/core/bridge.js` is its peer, and `test/mocks/bridge-mock.js` is a reference host used only by offline tests.

## Shape

One request, one response, one process. The broker writes a single JSON object to the host's stdin and closes it; the host writes a single JSON object to stdout and exits `0`. No session, no streaming, no negotiation. Requests carry content, so they go over stdin — never argv, which is readable from the process table.

The broker is the client. It never listens, never accepts a connection, and never holds host state between calls.

```json
{ "bridge": "0.1", "id": "b0b1…", "service": "stitch", "resource": "design", "action": "list", "params": { "project": "alpha" }, "limit": 20 }
```

```json
{ "bridge": "0.1", "id": "b0b1…", "ok": true, "items": [ … ], "total": 2, "truncated": false }
```

Both messages validate against `schemas/bridge-message.schema.json`.

Success always carries `items`, even for single-resource reads — a `view` returns a one-element array and the adapter maps an empty array to `bridge-not-found`. `total` is omitted rather than guessed when the host cannot count; a limited page reports `truncated: true` and the envelope degrades to `totalKnown: false`.

## Discovery

`resource: "bridge"`, `action: "describe"` returns declared capabilities as `items`, in the same shape the service manifest uses:

```json
{ "resource": "design", "actions": ["list", "view"], "mutation": false }
```

`describe` must not require authentication — it reports what the host *can* do, not whether it currently can. Authentication state belongs in `doctor`, exactly as it does for CLI adapters.

## Trust boundary

The host is untrusted input. Every field is validated before it reaches an envelope:

- **Version.** `bridge` must equal `0.1` exactly, or the call fails `bridge-version-mismatch`. There is no forward negotiation in this draft.
- **Correlation.** The response `id` must echo the request `id`, or the call fails `bridge-protocol-error`. This is what stops a confused or replaying host from answering the wrong question.
- **Closed error set.** A failing response may only use `unauthenticated`, `unavailable`, `not-found`, `invalid-request`, `rate-limited`, or `internal`. Anything else is a protocol error. The host's `message` is read and discarded — only the mapped AXI code survives, so a host cannot inject text into the broker's output.
- **No mutation.** A `describe` declaring `mutation: true` is refused at `bridge-mutation-rejected`. Mutation stays blocked until the separately reviewed plan/`--apply`/idempotency contract exists.
- **Bounds.** Requests allow at most 16 scalar params of at most 256 characters. Responses inherit the existing 20s timeout, 512 KB output cap, and bounded process-tree termination from `src/core/process.js`.

The broker still exports no credentials. A bridge inherits whatever authority the host already holds; it never receives, forwards, or stores secret material. A host that already has excessive authority remains outside the trust boundary, same as a malicious binary on `PATH`.

## Error mapping

| Host code | AXI code | Retryable |
|---|---|---|
| `unauthenticated` | `bridge-unauthenticated` | no |
| `unavailable` | `bridge-unavailable` | yes |
| `not-found` | `bridge-not-found` | no |
| `invalid-request` | `bridge-invalid-request` | no |
| `rate-limited` | `bridge-rate-limited` | yes |
| `internal` | `bridge-internal-error` | yes |

Non-zero host exit maps to `bridge-unavailable`. Malformed framing maps to `bridge-protocol-error`, which is never retryable — a host that cannot frame a response will not frame it correctly on a retry.

## Open questions

Deliberately unresolved in `0.1`, because no real host has exercised them yet:

- **Process reuse.** One process per call is the honest starting point and matches the existing subprocess safety model. An MCP host that pays a real handshake cost per call may justify a pooled long-lived session; that needs its own lifecycle and cancellation contract before it is worth the complexity.
- **Registration.** Where a host declares its executable and prefix argv — configuration file, `doctor` probe, or explicit user approval per service — is a separate decision from the wire format. Until it lands, `doctor` continues to report these services as `host-bridge-required` rather than probing.
- **Pagination.** `limit` and `truncated` cover the first increment. Cursors are additive later and would be a minor contract change.
