---
"@claudexor/schema": patch
"@claudexor/core": patch
"@claudexor/harness-codex": patch
"@claudexor/harness-claude": patch
"@claudexor/orchestrator": patch
"@claudexor/cli": patch
"@claudexor/control-api": patch
"@claudexor/daemon": patch
---

Resolve effort preferences at the final native route using the strongest supported level at or below a known request, with an explicitly recorded minimum or vendor-default omission when applicable. Preserve advertised future values, original preferences and model identities. Add shared typed effort evidence to model results and final attempt telemetry; keep adaptation disclosures in logs.

Preserve strict legacy model results unless creation opts into `captureEffortEvidence=true`, binding that choice to idempotency while keeping exact stored bytes and digest acknowledgement. Keep effort verification metadata in negotiated account catalogs only. Refuse unplaceable effort without retrying another route, clean temporary Codex authorization on preparation exit, and describe prepared controls without claiming dispatch.
