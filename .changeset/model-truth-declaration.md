---
"@claudexor/core": patch
"@claudexor/schema": patch
"@claudexor/cli": patch
"@claudexor/gateway": patch
"@claudexor/orchestrator": patch
"@claudexor/harness-cursor": patch
"@claudexor/harness-codex": patch
---

Model admission is the harness's own declaration, honoured on every list it owns.

`model_inventory_absence` used to govern only a live `models()` answer; every manifest hint list stayed strict by construction, so a settings write, the doctor's configured-model check and the explicit reviewer panel refused any id the shipped list lacked (and `claudexor models` could show nothing beyond that list), so a new vendor model needed a Claudexor release to become usable through them (#338, #340). `validateModel` now takes the list, its source and the declaration with no defaults; the manifest branches of the run gate and the reviewer panel read the declaration; one registry gate (`checkHarnessModel`) replaces the four hand-built copies in the settings write, doctor readiness and the capability catalog.

Claude, Codex and Cursor declare `advisory` (cursor gains the declaration here; claude's producer lands beside it): their lists prove presence, never absence, so an unlisted explicit model is persisted or forwarded byte-identical and the vendor decides. Each admitting consumer says so once: the settings read-back carries server-owned `notes` (the CLI prints them), the readiness row carries the note in its detail (the text `doctor` prints it too), the per-spawn gate keeps its status event; the agent capability catalog's `configuredModelValid` stays a boolean that reports such an admission as valid without the note (its description says so). raw-api, agy and opencode stay authoritative; the automatic reviewer panel keeps skipping an unlisted family at zero cost; HTTP model operations stay strict against the account catalog read at a named client version. Refusals state observations (which account supplied which list, how many models) instead of guessing a cause such as re-authentication.

Invariants: INV-104 amended with the owner's approval of 2026-09-24 (CONCEPT-CHANGE): absence is a per-harness declaration honoured on live and manifest lists alike; the settings-write-strict canary moves to agy and `[INV-104:settings-write-advisory]` pins the codex path. INV-105 unchanged (the per-spawn disclosure stays). INV-020/INV-022 hold: `notes` has a producer (the settings write) and readers (the CLI, the canary).
