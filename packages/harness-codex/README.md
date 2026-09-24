# @claudexor/harness-codex

Internal package of [Claudexor](https://github.com/razzant/claudexor) — Codex CLI adapter over the native app-server JSON-RPC lifecycle.

One app-server child owns one Claudexor run. Native goal continuations and
run-owned background terminals keep that run active; Stop pauses the goal,
interrupts the exact active turn, and terminates only terminals observed in
that run.

Published as part of the Claudexor toolchain; it follows the monorepo's
lockstep version and has no separate semver contract. Use the `claudexor`
CLI (or `@claudexor/cli`) as the supported entry point.
