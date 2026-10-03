import { describe, expect, it } from "vitest";
import { PreProgressRefusalLedger } from "./pre-progress-refusal-ledger.js";

const T0 = Date.parse("2026-09-28T19:52:00.000Z");
const MINUTE = 60_000;

function ledgerAt(): { ledger: PreProgressRefusalLedger; clock: { now: number } } {
  const clock = { now: T0 };
  return { ledger: new PreProgressRefusalLedger(() => new Date(clock.now)), clock };
}

function refused(over: Partial<Parameters<PreProgressRefusalLedger["record"]>[0]> = {}) {
  return {
    harness_id: "cursor",
    profile_id: "a",
    requested_model: "grok-4.7" as string | null,
    ...over,
  };
}

describe("PreProgressRefusalLedger (bounded self-expiring ordering evidence, #363)", () => {
  it("stamps an observation with its own clock and the one-hour retention", () => {
    const { ledger } = ledgerAt();
    ledger.record(refused());
    expect(ledger.live()).toEqual([
      {
        ...refused(),
        observed_at: new Date(T0).toISOString(),
        expires_at: new Date(T0 + 60 * MINUTE).toISOString(),
      },
    ]);
  });

  it("rejects a malformed observation loudly and stores nothing", () => {
    const { ledger } = ledgerAt();
    expect(() => ledger.record(refused({ profile_id: "" }))).toThrow();
    expect(() =>
      ledger.record({ ...refused(), wording: "out of usage" } as unknown as ReturnType<
        typeof refused
      >),
    ).toThrow();
    expect(ledger.live()).toEqual([]);
  });

  it("an expired observation is never served (clearing contract: self-expiry)", () => {
    const { ledger, clock } = ledgerAt();
    ledger.record(refused());
    clock.now = T0 + 60 * MINUTE - 1;
    expect(ledger.live()).toHaveLength(1);
    clock.now = T0 + 60 * MINUTE;
    expect(ledger.live()).toEqual([]);
  });

  it("keys by (harness, account, requested model); the default model is its own key", () => {
    const { ledger, clock } = ledgerAt();
    ledger.record(refused());
    clock.now = T0 + 5 * MINUTE;
    ledger.record(refused());
    ledger.record(refused({ requested_model: null }));
    ledger.record(refused({ requested_model: "" }));
    ledger.record(refused({ profile_id: "b" }));
    expect(ledger.live()).toHaveLength(4);
    expect(ledger.live()[0]?.observed_at).toBe(new Date(T0 + 5 * MINUTE).toISOString());
  });

  it("a served try clears exactly its (account, requested model) mark", () => {
    const { ledger } = ledgerAt();
    ledger.record(refused());
    ledger.record(refused({ requested_model: null }));
    ledger.record(refused({ profile_id: "b" }));
    ledger.clear("cursor", "a", "grok-4.7");
    expect(ledger.live().map((o) => [o.profile_id, o.requested_model])).toEqual([
      ["a", null],
      ["b", "grok-4.7"],
    ]);
    // A served default-model try clears only the default-model mark.
    ledger.clear("cursor", "a", null);
    ledger.clear("codex", "b", "grok-4.7");
    expect(ledger.live().map((o) => [o.profile_id, o.requested_model])).toEqual([
      ["b", "grok-4.7"],
    ]);
  });

  it("credential-generation changes void verdicts: per subject, then wholesale", () => {
    const { ledger } = ledgerAt();
    ledger.record(refused());
    ledger.record(refused({ requested_model: null }));
    ledger.record(refused({ profile_id: "b" }));
    ledger.clearSubject("cursor", "a");
    expect(ledger.live().map((o) => o.profile_id)).toEqual(["b"]);
    ledger.noteCredentialChange();
    expect(ledger.live()).toEqual([]);
  });

  it("a mutation moves only its account's credential generation; a login/logout moves every one", () => {
    const { ledger } = ledgerAt();
    const a0 = ledger.generation("cursor", "a");
    const b0 = ledger.generation("cursor", "b");
    const other0 = ledger.generation("codex", "a");
    // Evidence never moves a generation: only a credential change does.
    ledger.record(refused());
    ledger.clear("cursor", "a", "grok-4.7");
    expect(ledger.generation("cursor", "a")).toBe(a0);
    ledger.clearSubject("cursor", "a");
    const a1 = ledger.generation("cursor", "a");
    expect(a1).not.toBe(a0);
    expect(ledger.generation("cursor", "b")).toBe(b0);
    expect(ledger.generation("codex", "a")).toBe(other0);
    ledger.noteCredentialChange();
    expect(ledger.generation("cursor", "a")).not.toBe(a1);
    expect(ledger.generation("cursor", "b")).not.toBe(b0);
  });

  it("stays bounded by dropping the earliest-expiring row", () => {
    const { ledger, clock } = ledgerAt();
    for (let i = 0; i < 64; i += 1) {
      clock.now = T0 + i;
      ledger.record(refused({ profile_id: `p${i}` }));
    }
    clock.now = T0 + 100;
    ledger.record(refused({ profile_id: "newest" }));
    const ids = ledger.live().map((o) => o.profile_id);
    expect(ids).toHaveLength(64);
    expect(ids).not.toContain("p0");
    expect(ids).toContain("newest");
  });

  it("inside an open login window of the harness records nothing and its generation is no number (#363)", () => {
    let open: string | null = null;
    const ledger = new PreProgressRefusalLedger(
      () => new Date(T0),
      (harness) => harness === open,
    );
    const before = ledger.generation("cursor", "a");
    open = "cursor";
    ledger.record(refused());
    expect(ledger.live()).toEqual([]);
    expect(Number.isNaN(ledger.generation("cursor", "a"))).toBe(true);
    // A try bound inside the window can never match again, nor one bound before.
    expect(ledger.generation("cursor", "a") === ledger.generation("cursor", "a")).toBe(false);
    expect(ledger.generation("cursor", "a") === before).toBe(false);
    // Another harness is untouched by this harness's window.
    ledger.record(refused({ harness_id: "claude" }));
    expect(ledger.live().map((o) => o.harness_id)).toEqual(["claude"]);
    open = null;
    expect(ledger.generation("cursor", "a")).toBe(before);
  });
});
