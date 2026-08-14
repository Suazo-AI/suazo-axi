# Extending

Add a service by defining a manifest that validates against `schemas/service-manifest.schema.json`, then implement a small adapter returning `{ data, meta }`. Register it in the catalog only after its status can be stated honestly.

Adapters must:

- expose named operations rather than raw command passthrough;
- accept values already validated at the CLI boundary and validate provider identifiers again where useful;
- inherit authentication without reading or copying secret material;
- use JSON provider output when available and normalize it into 3–4 useful default fields;
- return definitive empty states and aggregates without extra provider calls;
- use the bounded child-process helper for all subprocesses;
- keep diagnostics and raw provider content out of stdout and logs;
- include offline normalization and failure fixtures.

Add contextual help near the dispatcher, update both schemas if the stable contract changes, and document status as `implemented`, `planned`, `host-bridge-required`, or `unconfigured`. Runtime executable detection belongs only in `doctor`; never turn a detection snapshot into a lifecycle claim.

Runtime doctor status is distinct from durable lifecycle status. Its declared vocabulary is `ready`, `authentication-required`, `unavailable`, `degraded`, `daemon-stopped`, `detected`, `not-detected`, `host-bridge-required`, and `unconfigured`; `daemon-stopped` is reserved for an available CLI whose local daemon explicitly reports that it is stopped.

Mutating capabilities must remain false until the CLI supports a previewable plan, explicit `--apply`, and idempotency keys. Version the capability and preserve a read-only rollback path.
