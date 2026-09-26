---
"@claudexor/schema": minor
"@claudexor/control-api": minor
"@claudexor/daemon": minor
"@claudexor/orchestrator": minor
"@claudexor/cli": minor
---

Add `POST /v2/runs/:id/messages`: a live message into a running run's active attempt with journal-first admission, typed outcomes (delivered, accepted, rejected, not_active, unsupported, delivery_unknown) plus reasons, and a key-required idempotent receipt. Each harness declares its live-input channel as `capability_profile.live_input`, projected as `liveInput` in the agent-capability catalog.
