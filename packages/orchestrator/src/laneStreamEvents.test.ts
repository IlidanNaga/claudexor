import { describe, expect, it } from "vitest";
import { createAttemptTelemetry, observeAttemptTelemetry } from "./attemptTelemetry.js";
import { emitTransientExhausted, emitTransientRetryPlan } from "./laneStreamEvents.js";
import type { HarnessEvent } from "@claudexor/schema";

// `route.transient.exhausted` used to report the CONFIGURED ceiling as the
// number of retries, so a run the vendor refused once read "exhausted 2
// retries" when zero had run. `retries` is now the observed count and the
// ceiling travels beside it as `max_retries`.

const policy = { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 1000 };

function ev(partial: Record<string, unknown> & { type: string }): HarnessEvent {
  return { session_id: "s", ts: "2026-09-21T00:00:00.000Z", ...partial } as unknown as HarnessEvent;
}

function recorder() {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  return {
    events,
    emit: (type: string, payload: Record<string, unknown>) => void events.push({ type, payload }),
  };
}

describe("transient retry disclosure", () => {
  it("reports ZERO observed retries (and the ceiling) when the failure was never retried", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    observeAttemptTelemetry(
      telemetry,
      ev({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } }),
    );
    const { events, emit } = recorder();
    emitTransientExhausted(emit, "codex", "a01", telemetry, policy.maxRetries);
    expect(events).toEqual([
      {
        type: "route.transient.exhausted",
        payload: {
          harness_id: "codex",
          attempt_id: "a01",
          category: "unknown_harness_error",
          retries: 0,
          max_retries: 2,
        },
      },
    ]);
  });

  it("counts each scheduled retry, discloses the failure that scheduled it, and then reports the count", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    const { events, emit } = recorder();
    observeAttemptTelemetry(
      telemetry,
      ev({ type: "status", transient: { kind: "network", retry_delay_ms: 70 } }),
    );
    expect(emitTransientRetryPlan(emit, "codex", "a01", telemetry, 0, policy)).toBe(70);
    observeAttemptTelemetry(telemetry, ev({ type: "status", transient: { kind: "timeout" } }));
    expect(emitTransientRetryPlan(emit, "codex", "a01", telemetry, 1, policy)).toBe(20);
    expect(telemetry.transientRetries).toBe(2);
    expect(events.map((e) => e.type)).toEqual([
      "route.transient.detected",
      "route.transient.retry_scheduled",
      "route.transient.detected",
      "route.transient.retry_scheduled",
    ]);
    expect(events[0]?.payload).toMatchObject({
      kind: "network",
      category: "unknown_harness_error",
      native_try: 1,
    });
    expect(events[2]?.payload).toMatchObject({ kind: "timeout", category: "timeout" });
    expect(events[3]?.payload).toMatchObject({ retry: 2, delay_ms: 20 });

    events.length = 0;
    emitTransientExhausted(emit, "codex", "a01", telemetry, policy.maxRetries);
    expect(events[0]?.payload).toMatchObject({ category: "timeout", retries: 2, max_retries: 2 });
  });

  it("stays silent when no transient failure was ever classified", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    const { events, emit } = recorder();
    emitTransientExhausted(emit, "codex", "a01", telemetry, policy.maxRetries);
    expect(events).toEqual([]);
    expect(telemetry.transientRetries).toBe(0);
  });
});
