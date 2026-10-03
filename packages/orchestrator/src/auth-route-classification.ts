import type { RouteAuthEvidence } from "@claudexor/budget";
import type {
  AuthPreference,
  AuthSourceReadiness,
  AuthVerification,
  CredentialProfileStatus,
} from "@claudexor/schema";

/**
 * Auth-mode classification for route ranking and billing evidence (#121
 * part 1). Two small total maps keep the ladder in `orderPool` /
 * `routeBillingKnowledge` honest: a lane's classification comes from the
 * FROZEN quota-admission credential route when one exists, else from the
 * RESOLVED auth preference (per-run > per-harness config > global config via
 * `authPreferenceForHarness`) — never from the raw run input, which reads
 * `auto` for every config-level preference user.
 */

/** The routing auth mode a frozen quota-admission credential route proves. */
export function authModeForCredentialRoute(
  route: "managed_api_key" | "vendor_native" | null,
): "api_key" | "local_session" | null {
  if (route === "managed_api_key") return "api_key";
  if (route === "vendor_native") return "local_session";
  return null;
}

/** The routing auth mode a RESOLVED preference claims; `auto` claims none
 * (the caller falls back to settled-metric/manifest evidence). */
export function authModeForPreference(
  preference: AuthPreference,
): "api_key" | "local_session" | null {
  if (preference === "api_key") return "api_key";
  if (preference === "subscription") return "local_session";
  return null;
}

/**
 * The billing verification one selected profile's own readiness proves
 * (#260). Only a fresh vendor-backed verdict counts: `passed` from the local
 * store says a login file is present, and a bounded stale observation is
 * never a fresh pass (INV-060: transport proof is not entitlement).
 */
export function profileBillingVerification(status: CredentialProfileStatus): AuthVerification {
  return status.verification_source === "vendor" && status.stale !== true
    ? status.verification
    : "not_run";
}

/**
 * Typed auth-route evidence for one candidate (QA-034): the concrete
 * credential route the resolved auth mode maps to, plus the verification for
 * the credential that route runs under. A profile selected at quota admission
 * is judged by its own verification (#260): the doctor's `auth_sources`
 * describe the default store, a different credential. Only a profile-less
 * route reads them — `local_session` → vendor_native + the native/OAuth source
 * verification; `api_key` → managed_api_key + the key source verification.
 * Unknown route → no evidence (the router keeps its conservative
 * metric-derived billing). Verification is a typed verdict — never inferred
 * from mere availability.
 */
export function authRouteEvidenceFor(
  authMode: "local_session" | "api_key" | "unknown",
  sources: readonly AuthSourceReadiness[],
  profileVerification: AuthVerification | null,
): RouteAuthEvidence | undefined {
  if (authMode === "unknown") return undefined;
  const route = authMode === "api_key" ? "managed_api_key" : "vendor_native";
  if (profileVerification !== null) return { route, verification: profileVerification };
  const usable = (s: AuthSourceReadiness): boolean =>
    s.availability === "available" && s.verification !== "failed";
  const source = sources.find(
    (s) =>
      usable(s) &&
      (authMode === "local_session"
        ? s.source === "native_session" || s.source === "oauth_token_env"
        : s.source === "api_key_env" ||
          s.source === "api_key_flag" ||
          s.source === "provider_auth_file"),
  );
  return { route, verification: source?.verification ?? "not_run" };
}
