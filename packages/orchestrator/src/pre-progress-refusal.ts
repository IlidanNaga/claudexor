/**
 * Cross-run memory of a pool account's PRE-PROGRESS REFUSAL (#363).
 *
 * The structural rotation branch (`structural_pre_progress_failure`) already
 * moves one run off an account whose vendor refused it before any work, without
 * reading the vendor's wording. This module carries that same typed outcome to
 * LATER unpinned runs: the account is ranked after its selectable siblings for
 * the same requested model until the observation expires, the account serves
 * that model again, or its credential changes. It never excludes a row, never
 * touches an explicit pin, and never claims spent quota (the cooldown
 * projection owns typed limits) or a dead credential (the A7 unusable ledger).
 *
 * Only a session the adapter reported as STARTED counts: an adapter's own
 * pre-spawn refusal — a readiness probe that could not confirm the login, a
 * misconfigured route — is not the vendor refusing the account.
 */
import type { HarnessRunSpec, PreProgressRefusalObservation } from "@claudexor/schema";
import type { AttemptOutputMarkers } from "./attemptOutputMarkers.js";
import { rotationRetryEligible, type RotationEvidence } from "./rotation-predicate.js";

/** The orchestrator's view of the daemon-owned bounded ledger. */
export interface PreProgressRefusalMemory {
  live(): readonly PreProgressRefusalObservation[];
  /** Moves when a credential change voids the account's verdicts. */
  generation(harnessId: string, profileId: string): number;
  record(value: Omit<PreProgressRefusalObservation, "observed_at" | "expires_at">): void;
  clear(harnessId: string, profileId: string, requestedModel: string | null): void;
}

/** One try's outcome sink, bound before its session spawns. */
export interface PreProgressRefusalSubject {
  note(): void;
  noteServed(markers: AttemptOutputMarkers, delivered: boolean): void;
}

/**
 * The try's vendor session started and then ended in the structural branch's
 * own evidence: a terminal non-transient death with no agent progress, no
 * deliverable and no mutation. A TYPED limit is excluded on purpose — the quota
 * registry already records it as a cooldown the pool ranks as exhausted.
 */
export function refusedBeforeProgress(
  evidence: RotationEvidence,
  markers: AttemptOutputMarkers,
): boolean {
  return (
    !evidence.sawTypedLimit && markers.sawSessionStart === true && rotationRetryEligible(evidence)
  );
}

/**
 * Bind one try's subject — (harness, subscription account, requested model) —
 * to the memory, BEFORE the try's session spawns. Null when there is nothing
 * to remember: no memory configured, a profile-less default subject, or a
 * metered api_key row (never a pool row).
 *
 * The binding also holds the account's credential generation: a profile
 * mutation or login/logout does not wait for runs in flight, so an outcome
 * arriving after one is about a credential that change already voided. It
 * neither recreates the mark the change cleared nor clears a mark a later try
 * recorded about the changed credential.
 */
export function preProgressRefusalSubject(
  memory: PreProgressRefusalMemory | undefined,
  harnessId: string,
  spec: Pick<HarnessRunSpec, "credential_profile" | "model_hint">,
): PreProgressRefusalSubject | null {
  const profile = spec.credential_profile ?? null;
  if (!memory || !profile || profile.credential_kind === "api_key") return null;
  const requestedModel = spec.model_hint ?? null;
  const generation = memory.generation(harnessId, profile.profile_id);
  const unchanged = () => memory.generation(harnessId, profile.profile_id) === generation;
  return {
    note: () => {
      if (!unchanged()) return;
      memory.record({
        harness_id: harnessId,
        profile_id: profile.profile_id,
        requested_model: requestedModel,
      });
    },
    // Agent progress, or an error-free try that delivered, proves the account
    // served this model; a cancelled or empty try proves nothing.
    noteServed: (markers, delivered) => {
      if (unchanged() && (markers.sawAgentProgress || delivered)) {
        memory.clear(harnessId, profile.profile_id, requestedModel);
      }
    },
  };
}

/**
 * The latest live mark per account for this harness and requested model — the
 * instant the pool orders a demoted row by (oldest mark first).
 */
export function liveRefusalMarks(
  refusals: readonly PreProgressRefusalObservation[],
  harnessId: string,
  model: string | null | undefined,
  now: number,
): Map<string, number> {
  const marks = new Map<string, number>();
  for (const obs of refusals) {
    if (obs.harness_id !== harnessId || obs.requested_model !== (model ?? null)) continue;
    const observed = Date.parse(obs.observed_at);
    const expires = Date.parse(obs.expires_at);
    if (!Number.isFinite(observed) || !Number.isFinite(expires) || expires <= now) continue;
    marks.set(obs.profile_id, Math.max(observed, marks.get(obs.profile_id) ?? observed));
  }
  return marks;
}
