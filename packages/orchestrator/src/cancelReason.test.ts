import { describe, expect, it } from "vitest";
import { RunOutcomeFacts } from "@claudexor/schema";
import { cancelReasonFromSignalToken } from "./runTerminals.js";

describe("cancelReasonFromSignalToken (X-5)", () => {
  it("maps the typed tokens and coerces everything else to user_cancelled", () => {
    expect(cancelReasonFromSignalToken("wall_clock_exceeded")).toBe("wall_clock_exceeded");
    expect(cancelReasonFromSignalToken("host_cancelled")).toBe("host_cancelled");
    expect(cancelReasonFromSignalToken("owner_task_gone")).toBe("owner_task_gone");
    // Wire compatibility: a bare abort, free text, or a non-string reason all
    // keep the historical user_cancelled coercion.
    expect(cancelReasonFromSignalToken(undefined)).toBe("user_cancelled");
    expect(cancelReasonFromSignalToken("ctrl-c on the waiting CLI")).toBe("user_cancelled");
    expect(cancelReasonFromSignalToken(new Error("x"))).toBe("user_cancelled");
  });

  it("the new reasons are admitted on a cancelled lifecycle", () => {
    for (const reason of ["host_cancelled", "owner_task_gone"] as const) {
      const facts = RunOutcomeFacts.parse({
        lifecycle: "cancelled",
        noChanges: true,
        checks: "not_configured",
        review: "not_run",
        reason,
      });
      expect(facts.reason).toBe(reason);
    }
  });
});

describe("cancel-reason raw-boundary guard (adversarial wave)", () => {
  it("only closed-enum members become abort tokens; wall_clock_exceeded is not forgeable", async () => {
    const { normalizeCancelReasonCode } = await import("@claudexor/schema");
    expect(normalizeCancelReasonCode("host_cancelled")).toBe("host_cancelled");
    expect(normalizeCancelReasonCode("owner_task_gone")).toBe("owner_task_gone");
    expect(normalizeCancelReasonCode("user_cancelled")).toBe("user_cancelled");
    // The deadline terminal is produced only in-process; a cancel control
    // must never forge it — and arbitrary text (newline injection into
    // final/summary.md, secret-shaped strings) must never reach abort().
    expect(normalizeCancelReasonCode("wall_clock_exceeded")).toBeUndefined();
    expect(normalizeCancelReasonCode("owner_task_gone\n- Lifecycle: succeeded")).toBeUndefined();
    expect(normalizeCancelReasonCode("sk-ant-api03-not-a-key")).toBeUndefined();
    expect(normalizeCancelReasonCode(42)).toBeUndefined();
    expect(normalizeCancelReasonCode(undefined)).toBeUndefined();
  });

  it("the HTTP boundary rejects non-enum reason_code", async () => {
    const { ControlRunControlRequest } = await import("@claudexor/schema");
    expect(() =>
      ControlRunControlRequest.parse({
        control: { kind: "cancel", reason_code: "wall_clock_exceeded" },
      }),
    ).toThrow();
    const ok = ControlRunControlRequest.parse({
      control: { kind: "cancel", reason_code: "host_cancelled" },
    });
    expect(ok.control.reason_code).toBe("host_cancelled");
  });
});
