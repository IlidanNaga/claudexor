import type { ModelSubstitutionObservation } from "@claudexor/schema";
import { ModelSubstitutionObservation as ModelSubstitutionObservationSchema } from "@claudexor/schema";

/** Observation retention, not a vendor reset time; a false mark costs only ordering. */
const TTL_MS = 30 * 60_000;
/** Bounded memory: the ledger holds evidence, not history. */
const MAX_ROWS = 64;

/**
 * The daemon's bounded, self-expiring memory of typed model-substitution
 * observations: "this account answered a model operation's request for model M
 * with another model".
 *
 * The vendor state behind it is per account, lasts tens of minutes and is
 * invisible in the quota meter, while the pool's choice is deterministic by
 * headroom — without this memory the caller's next operation lands on the same
 * account. A live observation only ORDERS the pool for that requested model
 * (INV-135); it never excludes a row, never touches a pin or a preferred
 * account, and the engine still performs one generation per operation
 * (INV-014).
 *
 * Deliberately IN-MEMORY, like the `CredentialUnusableLedger` beside it: a
 * restart costs at most one rediscovering operation.
 *
 * Clearing contract:
 * 1. self-expiry — every row is stamped here with the one retention above;
 * 2. NO success-clear: inside an episode the same account still serves the
 *    requested model now and then, which would erase the mark within seconds;
 * 3. a credential-generation change voids the verdicts about the changed
 *    generation, at the unusable ledger's call sites: a login/logout clears the
 *    WHOLE ledger (`noteCredentialChange`), a control-API profile mutation
 *    clears PER SUBJECT (`clearSubject`). A secret mutation names no subject
 *    here — model operations admit managed-login rows only.
 */
export class ModelSubstitutionLedger {
  private rows = new Map<string, ModelSubstitutionObservation>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Validate and stamp, newest-wins per (subject, requested model). */
  record(value: Omit<ModelSubstitutionObservation, "observed_at" | "expires_at">): void {
    const at = this.now().getTime();
    const obs = ModelSubstitutionObservationSchema.parse({
      ...value,
      observed_at: new Date(at).toISOString(),
      expires_at: new Date(at + TTL_MS).toISOString(),
    });
    this.prune();
    if (this.rows.size >= MAX_ROWS && !this.rows.has(key(obs))) {
      // Bounded: drop the earliest-expiring row rather than refusing evidence.
      const earliest = [...this.rows.entries()].reduce((a, b) =>
        Date.parse(a[1].expires_at) <= Date.parse(b[1].expires_at) ? a : b,
      );
      this.rows.delete(earliest[0]);
    }
    this.rows.set(key(obs), obs);
  }

  /** Every un-expired observation (the read side of account resolution). */
  live(): readonly ModelSubstitutionObservation[] {
    this.prune();
    return [...this.rows.values()];
  }

  /** Credential generation changed wholesale (login/logout): every verdict
   * about the old generation is void. */
  noteCredentialChange(): void {
    this.rows.clear();
  }

  /** ONE account's credential changed (a control-API profile mutation): only
   * ITS verdicts are void, across every requested model. */
  clearSubject(harnessId: string, profileId: string): void {
    for (const [k, obs] of this.rows) {
      if (obs.harness_id === harnessId && obs.profile_id === profileId) this.rows.delete(k);
    }
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [k, obs] of this.rows) {
      if (Date.parse(obs.expires_at) <= now) this.rows.delete(k);
    }
  }
}

function key(obs: ModelSubstitutionObservation): string {
  return [obs.harness_id, obs.profile_id, obs.requested_model].join("\0");
}
