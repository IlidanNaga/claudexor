/**
 * ONE owner for what a control-API credential mutation invalidates: the
 * doctor/status projections, the quota registry's absence pacing, and — per
 * subject — the A7 unusable-credential ledger. The per-subject half of the
 * ledger's clearing contract lives HERE (profile enable/disable/create/remove
 * and secret set/delete each void exactly the verdicts about the credential
 * they touched), while the whole-ledger clear stays with the login/logout
 * lifecycle: claudexord's setup jobs, including Cursor profile login, at each
 * opening/closing transition. Direct Claude/AGY profile login retains its
 * documented observation gap. Clearing is
 * fail-open by contract: over-clearing costs at most one attempt rediscovering
 * a refusal. The model-substitution and pre-progress refusal ledgers clear at
 * the same sites; a secret names their subjects through the registry rows
 * whose `secret_ref` it is (an `oauth_token` row is a subscription account).
 * The Cursor status cache is dropped with the Claude auth-status LKG.
 */
import { loadConfig } from "@claudexor/config";
import { invalidateDoctorCache } from "@claudexor/core";
import { clearClaudeAuthStatusCache } from "@claudexor/harness-claude";
import { clearCursorStatusCache } from "@claudexor/harness-cursor";
import type { QuotaRegistry } from "@claudexor/daemon";
import type { AuthReadinessService } from "@claudexor/gateway";
import { noProjectRepoRoot } from "@claudexor/util";
import { forgetClaudeOauthRejections } from "./claude-oauth-usage.js";
import { invalidateStatusProjections } from "./status-projection-cache.js";
import { credentialUnusableLedger, preProgressRefusalLedger } from "./run-orchestrator.js";
import { modelSubstitutionLedger } from "./model-services.js";

/** The credential a control-API mutation touched: one registered profile, or
 * a secret name whose subjects are resolved through the registry. */
export type CredentialMutationSubject =
  { harnessId: string; profileId: string } | { secretName: string };

export function bustCredentialStatusCaches(
  quotaRegistry: () => QuotaRegistry,
  subject?: CredentialMutationSubject,
): void {
  // Auth-status keeps a short process-local LKG only to survive a transient
  // probe transport error. Any explicit credential mutation must invalidate it
  // before status/probe consumers can observe the changed store.
  clearClaudeAuthStatusCache();
  // Cursor reuses a recent positive status answer; a mutation must re-ask.
  clearCursorStatusCache();
  // The quota poller's remembered vendor rejections are credential state too:
  // a login or profile change makes every remembered token worth re-asking.
  forgetClaudeOauthRejections();
  invalidateDoctorCache();
  invalidateStatusProjections();
  quotaRegistry().noteCredentialChange();
  if (!subject) return;
  if ("harnessId" in subject) {
    credentialUnusableLedger.clearSubject(subject.harnessId, subject.profileId);
    modelSubstitutionLedger.clearSubject(subject.harnessId, subject.profileId);
    preProgressRefusalLedger.clearSubject(subject.harnessId, subject.profileId);
    return;
  }
  // A secret names its subjects indirectly: profiles whose secret_ref IS this
  // name, and — for a bare managed name — the engine-default slot of whichever
  // harness reads it (adapter knowledge the daemon does not duplicate).
  for (const profile of loadConfig(noProjectRepoRoot()).global.credential_profiles) {
    if (profile.secret_ref !== subject.secretName) continue;
    credentialUnusableLedger.clearSubject(profile.harness_id, profile.profile_id);
    modelSubstitutionLedger.clearSubject(profile.harness_id, profile.profile_id);
    // Moves the row's credential generation too: a try bound to the old
    // secret neither records nor clears a mark about the new one (#363).
    preProgressRefusalLedger.clearSubject(profile.harness_id, profile.profile_id);
  }
  if (!subject.secretName.includes(":")) credentialUnusableLedger.clearDefaultSubjects();
}

/** Clear the process-wide observations after a daemon login/logout lifecycle.
 * The in-memory ledgers and generations move first: the quota registry read
 * last is the one step that can fail. */
export function bustGlobalCredentialStatusCaches(quotaRegistry: () => QuotaRegistry): void {
  credentialUnusableLedger.noteCredentialChange();
  modelSubstitutionLedger.noteCredentialChange();
  preProgressRefusalLedger.noteCredentialChange();
  bustCredentialStatusCaches(quotaRegistry);
}

/** A setup job's credential-mutation window opened or closed (#363): the
 * native login may have changed the credential, whatever its exit — the
 * process-wide observations plus that harness's auth-readiness projection. */
export function bustLoginCredentialState(
  quotaRegistry: () => QuotaRegistry,
  authReadiness: Pick<AuthReadinessService, "invalidate">,
  harness: string,
): void {
  authReadiness.invalidate(harness);
  bustGlobalCredentialStatusCaches(quotaRegistry);
}
