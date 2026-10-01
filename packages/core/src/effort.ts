import { EffortPreferenceRejectedError } from "./errors.js";
import { mergeEffortLadders, type EffortHint, type EffortResolution } from "@claudexor/schema";

/**
 * Effort resolution against VENDOR-ordered ladders. There is no static rank
 * table anywhere in this repo: a level's rank is its position in the ladder the
 * vendor itself advertised (a model's own ordered list, or the harness's merged
 * ladder — `mergeEffortLadders` in the schema package). Ranking is NOT
 * permission: what a run may actually use is whatever the resolved (harness,
 * model) ADVERTISES, so a level newer than this repo passes through untouched
 * the moment the vendor ships it.
 */

/**
 * Outcome of resolving a requested effort against an advertised vocabulary.
 * `rejected` carries actionable text naming what IS advertised — an unknown
 * level is never silently downgraded into something we merely guessed at.
 */
export type EffortCheck =
  | { status: "ok"; effort: EffortHint | null; clamped: boolean }
  | { status: "rejected"; message: string };

/** Only a vendor-proven total order may drive substitutions. The display merge
 * breaks ties between disconnected/branching chains; those ties are not ranks.
 * Exact membership remains usable even when ordering cannot be established. */
export function effortRankLadder(
  lists: ReadonlyArray<readonly EffortHint[]>,
): readonly EffortHint[] {
  const merged = mergeEffortLadders(lists);
  if (!merged.consistent) return [];
  const { order } = merged;
  return order.every(
    (level, index) =>
      index === 0 ||
      lists.some((list) => {
        const before = list.indexOf(order[index - 1]!);
        return before >= 0 && list[before + 1] === level;
      }),
  )
    ? order
    : [];
}

/**
 * Resolve a requested reasoning-effort level against the levels a specific
 * (harness, model) advertises. THE single owner of effort semantics; every
 * surface (adapters, settings writes, preflight) resolves through it.
 *
 * `advertised` is what the resolved target accepts (the model's own ordered
 * list, or the harness ladder when the model recorded none). `ladder` is the
 * rank authority for clamping: the harness's MERGED vendor order, so a level
 * one sibling model advertises can clamp onto what THIS model accepts (`ultra`
 * on gpt-5.4 → `xhigh`, because the merged codex ladder places `ultra` above
 * it). It defaults to `advertised` itself — the degenerate case where nothing
 * beyond the target's own order is known, including a harness whose models'
 * orders CONTRADICT each other: pass `advertised` there, which makes
 * cross-model clamping impossible by construction and refuses instead of
 * inventing an order.
 *
 * - nothing requested → ok, no effort (pass no flag).
 * - `advertised` empty → ok, no effort: effort is not a tunable surface here, so
 *   the caller discloses it as ignored (INV-105) instead of clamping to a guess.
 * - requested IS advertised → PASS THROUGH VERBATIM. This is what makes a
 *   future vendor level work with no Claudexor change.
 * - requested is not advertised but the LADDER places it → choose the strongest
 *   advertised level not above the request. If every supported level exceeds
 *   the request, use the known minimum (reasoning cannot be disabled there).
 * - requested is unknown to the ladder too → REJECT, naming the advertised
 *   set. We cannot place it, so any "nearest" would be invented.
 */
export function resolveEffort(
  requested: EffortHint | null | undefined,
  advertised: readonly EffortHint[],
  ladder: readonly EffortHint[] = advertised,
): EffortCheck {
  if (requested === null || requested === undefined) {
    return { status: "ok", effort: null, clamped: false };
  }
  if (advertised.length === 0) return { status: "ok", effort: null, clamped: false };
  if (advertised.includes(requested)) return { status: "ok", effort: requested, clamped: false };

  const want = ladder.indexOf(requested);
  // Only levels the ladder places can host a clamp; a level outside the ladder
  // is a valid TARGET only through the exact-match branch above.
  const rankable = advertised.filter((level) => ladder.indexOf(level) >= 0);
  if (want < 0 || rankable.length === 0) {
    return {
      status: "rejected",
      message:
        `effort "${requested}" is not advertised here and the advertised ladder cannot place it ` +
        `(advertised: ${advertised.join(", ")})`,
    };
  }

  const ordered = [...rankable].sort((a, b) => ladder.indexOf(a) - ladder.indexOf(b));
  const lower = ordered.filter((level) => ladder.indexOf(level) <= want).at(-1);
  if (!lower && rankable.length !== advertised.length)
    return {
      status: "rejected",
      message: "The advertised minimum effort cannot be established from the vendor order.",
    };
  const best = lower ?? ordered[0]!;
  return { status: "ok", effort: best, clamped: true };
}

/**
 * Map a requested effort onto a level the resolved (harness, model) accepts, or
 * null when none should be sent. Thin translational wrapper over `resolveEffort`
 * for arg builders, which must never emit a level the vendor would reject: a
 * rejection yields null (send NO flag, keep the vendor default) rather than a
 * fabricated downgrade. Surfaces that can talk back to the user call
 * `resolveEffort` and report its `message`.
 */
export function normalizeEffort(
  requested: EffortHint | null | undefined,
  advertised: readonly EffortHint[],
  ladder: readonly EffortHint[] = advertised,
): EffortHint | null {
  const check = resolveEffort(requested, advertised, ladder);
  return check.status === "ok" ? check.effort : null;
}

/** Shared typed receipt; native adapters supply the final route's capability
 * facts. Empty supported and unavailable proof remain different outcomes. */
export function resolveEffortEvidence(
  requested: string | null | undefined,
  advertised: readonly string[],
  ladder: readonly string[],
  source: EffortResolution["source"],
  parameter: string | null,
  unverifiable = false,
): EffortResolution {
  const check = resolveEffort(requested, unverifiable ? [] : advertised, ladder);
  const base = {
    requested: requested ?? null,
    source,
    parameter,
    observed: null,
    observedSource: null,
  };
  if (check.status === "rejected")
    return { ...base, submitted: null, resolution: "rejected", reason: check.message };
  const submitted = check.effort;
  const resolution =
    submitted === null
      ? requested && unverifiable
        ? "unverifiable"
        : "omitted"
      : !check.clamped
        ? "exact"
        : ladder.indexOf(submitted) < ladder.indexOf(requested!)
          ? "downward"
          : "floor";
  return { ...base, submitted, resolution };
}

/** Diagnostic only: status events never inject assistant conversation text. */
export function effortResolutionEvent(
  sessionId: string,
  receipt: EffortResolution,
): import("@claudexor/schema").HarnessEvent {
  const detail =
    receipt.requested && receipt.resolution !== "exact"
      ? `effort=${receipt.requested}: ${receipt.resolution}; submitted=${receipt.submitted ?? "omitted (native default)"}`
      : null;
  return {
    type: "status",
    session_id: sessionId,
    ts: new Date().toISOString(),
    effort_resolution: receipt,
    ...(detail ? { text: `[effort] ${detail}`, payload: { ignored_settings: [detail] } } : {}),
  };
}

/** Native adapters stop before transport when their final route cannot place a preference. */
export function throwIfEffortRejected(receipt: import("@claudexor/schema").EffortResolution): void {
  if (receipt.resolution === "rejected")
    throw new EffortPreferenceRejectedError(
      receipt.reason ?? "The final route cannot place the effort preference.",
    );
}
