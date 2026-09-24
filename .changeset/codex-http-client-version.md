---
"@claudexor/schema": patch
"@claudexor/harness-codex": patch
"@claudexor/cli": patch
---

The Codex HTTP model transport declares its own verified client version when it reads an account's model catalog, instead of the managed-installer pin.

The Codex backend filters `GET /backend-api/codex/models` by the `client_version` the caller declares: a model is listed only for clients at or above that model's minimum version. Claudexor's raw model transport sent the installer pin (`CODEX_VENDOR_CLI_VERSION`, 0.153.3), so a newly floored model such as `gpt-6-sol` was absent from the catalog and refused as `model_unavailable`, while the same account and the same request shape generated with it (issue #339). A release that only moved the installer therefore decided which models an account could see through this route.

`CODEX_HTTP_CLIENT_VERSION` (0.156.1) is the version this release's catalog parser and Responses projection were verified against; it is raised to the installed Codex CLI's version when that is newer, never lowered, and an unparseable version falls back to the constant because the parameter is required. The value is memoised per binary identity, so an in-place CLI upgrade is seen on the next catalog read. The negotiated account view (`?view=accounts`) carries `clientVersion` and `clientVersionSource` per catalog (`verified_transport` or `installed_cli`; null for catalogs from an older engine) while the legacy `GET /model-sources/:id/models` keeps its pre-existing shape, and both membership refusals — account selection and invocation — name the declared version so a miss is not read as an account or login problem. The catalog stays strict: its rows are the request contract (efforts, service tiers, windows). A recorded fixture pair (`fixtures/models-http-0.153.3.json`, `models-http-0.156.1.json`) pins that every row present at both versions is identical and only `gpt-6-sol`/`gpt-6-luna` were added, with the default unchanged; bumping the constant re-records the pair.

Invariants: INV-104 is unchanged (HTTP model operations stay strict against the account catalog, now read at a named client version). INV-020/INV-022 hold: the two schema fields are produced by the transport, read by both membership refusals (`describeCodexClientVersion`) and returned on the account-view wire. The managed installer pin keeps its two other meanings (install target, fixture/effort-snapshot stamp).
