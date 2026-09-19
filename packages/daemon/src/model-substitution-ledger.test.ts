import { describe, expect, it } from "vitest";
import { ModelSubstitutionLedger } from "./model-substitution-ledger.js";

const T0 = Date.parse("2026-09-20T10:00:00.000Z");
const MINUTE = 60_000;

function ledgerAt(): { ledger: ModelSubstitutionLedger; clock: { now: number } } {
  const clock = { now: T0 };
  return { ledger: new ModelSubstitutionLedger(() => new Date(clock.now)), clock };
}

function seen(over: Partial<Parameters<ModelSubstitutionLedger["record"]>[0]> = {}) {
  return {
    harness_id: "codex",
    profile_id: "work",
    requested_model: "model-a",
    served_model: "model-b",
    ...over,
  };
}

describe("ModelSubstitutionLedger (bounded self-expiring ordering evidence)", () => {
  it("stamps an observation with its own clock and the 30-minute retention", () => {
    const { ledger } = ledgerAt();
    ledger.record(seen());
    expect(ledger.live()).toEqual([
      {
        ...seen(),
        observed_at: new Date(T0).toISOString(),
        expires_at: new Date(T0 + 30 * MINUTE).toISOString(),
      },
    ]);
  });

  it("rejects a malformed observation loudly (schema-parsed, never silently stored)", () => {
    const { ledger } = ledgerAt();
    expect(() => ledger.record(seen({ profile_id: "" }))).toThrow();
    expect(() =>
      ledger.record({ ...seen(), made_up: true } as unknown as ReturnType<typeof seen>),
    ).toThrow();
    expect(ledger.live()).toEqual([]);
  });

  it("an EXPIRED observation is never served (clearing contract: self-expiry)", () => {
    const { ledger, clock } = ledgerAt();
    ledger.record(seen());
    clock.now = T0 + 30 * MINUTE - 1;
    expect(ledger.live()).toHaveLength(1);
    clock.now = T0 + 30 * MINUTE;
    expect(ledger.live()).toEqual([]);
  });

  it("newest-wins per (account, requested model): a repeat refreshes, never duplicates", () => {
    const { ledger, clock } = ledgerAt();
    ledger.record(seen());
    clock.now = T0 + 10 * MINUTE;
    ledger.record(seen({ served_model: "model-c" }));
    ledger.record(seen({ requested_model: "model-z" }));
    ledger.record(seen({ profile_id: "other" }));
    expect(ledger.live()).toHaveLength(3);
    expect(ledger.live()[0]).toMatchObject({
      profile_id: "work",
      requested_model: "model-a",
      served_model: "model-c",
      observed_at: new Date(T0 + 10 * MINUTE).toISOString(),
      expires_at: new Date(T0 + 40 * MINUTE).toISOString(),
    });
  });

  it("a credential-generation change voids every verdict; a profile mutation only its own", () => {
    const { ledger } = ledgerAt();
    ledger.record(seen());
    ledger.record(seen({ requested_model: "model-z" }));
    ledger.record(seen({ profile_id: "other" }));
    ledger.record(seen({ harness_id: "claude" }));
    ledger.clearSubject("codex", "work");
    expect(ledger.live().map((o) => [o.harness_id, o.profile_id])).toEqual([
      ["codex", "other"],
      ["claude", "work"],
    ]);
    ledger.noteCredentialChange();
    expect(ledger.live()).toEqual([]);
  });

  it("stays bounded: the earliest-expiring row is evicted, never the newest evidence refused", () => {
    const { ledger, clock } = ledgerAt();
    for (let i = 0; i < 64; i += 1) {
      clock.now = T0 + i * 1000;
      ledger.record(seen({ profile_id: `p${i}` }));
    }
    // A refresh of a stored row never evicts a sibling.
    ledger.record(seen({ profile_id: "p0" }));
    expect(ledger.live()).toHaveLength(64);
    ledger.record(seen({ profile_id: "newest" }));
    const ids = ledger.live().map((o) => o.profile_id);
    expect(ids).toHaveLength(64);
    expect(ids).toContain("newest");
    expect(ids).toContain("p0");
    expect(ids).not.toContain("p1");
  });
});
