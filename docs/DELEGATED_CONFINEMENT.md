# Delegated confinement (retired)

This filename remains as a compact historical pointer because released
changelogs and review records link to it. Claudexor no longer applies an outer
Seatbelt or other OS filesystem wrapper to delegated harness processes, and
`external_sandbox_full` is not an active access profile.

Current delegated runs use the selected adapter's native access mode. Claudexor
may give the harness a scoped `HOME` or vendor profile directory to select the
right account and keep writable vendor state separate, but that directory is
not a containment boundary. New attempt evidence therefore records no outer
mechanism, digest, or denied path and carries the schema-owned deliberate-
absence reason. The caller-facing historical field remains named
`candidates[].confinement` so old run records and proven Seatbelt artifacts
stay readable; new records project `proven: false` with that reason.

The active profiles are `readonly`, `workspace_write`, `full`, and
`inherit_native`. Historical artifacts may still decode
`external_sandbox_full`, but active API, CLI, MCP, configuration, manifests,
and new run execution reject it. Exact idempotency replay first returns a
durably accepted historical command when one exists; a genuinely absent Exact
Retry refuses with `retired_access_profile`. Run Again requires an explicit
active replacement instead of silently widening access.

The current trust and execution model is documented in
[`ARCHITECTURE.md`](ARCHITECTURE.md) and [`../SECURITY.md`](../SECURITY.md).
Historical design and review evidence remains in Git history and the immutable
review ledger; it is not current runtime guidance.
