/**
 * Post-terminal vendor-failure side channel. `codex exec --json` reduces a
 * failed turn to a sentence, while the CLI's own session rollout keeps the
 * typed record (`codex_error_info`). When the shared run loop disclosed that
 * codex VOICED its own error (`harness_reported_error`), read that record once,
 * after the process exited, and attach it to the terminal `completed` payload
 * as `vendor_failure`. Evidence only: the adapter translates, the orchestrator
 * forwards it to the failure record, and nothing branches on the code.
 *
 * A separate module because `index.ts` sits at its complexity-ratchet baseline.
 */
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { codexTranscriptVendorFailure } from "./transcript.js";

export async function* withCodexVendorFailure(
  events: AsyncIterable<HarnessEvent>,
  spec: HarnessRunSpec,
  env: Record<string, string | null | undefined>,
  threadId: () => string | undefined,
): AsyncGenerator<HarnessEvent> {
  // Taken before the child is spawned: `events` is a lazy generator that only
  // starts when the loop below first pulls from it.
  const spawnedNotBeforeMs = Date.now();
  for await (const ev of events) {
    if (
      ev.type === "completed" &&
      !ev.aborted &&
      ev.payload?.["harness_reported_error"] === true &&
      // Same gate as the other transcript reads: auth-capability smokes and
      // the continuity summariser must not touch the rollout.
      spec.evidence_policy !== "stream_only"
    ) {
      const vendor = codexTranscriptVendorFailure(
        env["CODEX_HOME"],
        threadId(),
        spawnedNotBeforeMs,
      );
      if (vendor) {
        yield { ...ev, payload: { ...ev.payload, vendor_failure: vendor } };
        continue;
      }
    }
    yield ev;
  }
}
