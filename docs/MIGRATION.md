# Migration

Migration is incremental and read-first.

1. Wave 1 establishes the envelope, files, GitHub, catalog, and doctor commands.
2. Wave 2 may prefer compatible `gh-axi` and `chrome-devtools-axi` backends when detected while retaining current adapters as fallbacks.
3. Wave 3 adds planned CLIs and host bridges one service at a time behind manifests and contract tests.
4. Wave 4 considers mutations only with plan/apply separation, explicit `--apply`, idempotency keys, and provider-specific safety review.

Envelope compatibility follows semantic versioning for the package and a separate `axi` contract version. Additive fields may land in a minor release; removals, meaning changes, or default-shape expansion require a major contract version. Provider-specific fields should not leak into stable defaults.

Rollback is adapter-by-adapter: disable the new manifest selection and restore the previous ordered backend. Because authentication stays with the underlying transport and no data is migrated into this broker, rollback should not require credential or content movement. Keep old normalizers and contract fixtures for at least one release wave.
