import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const POLL_BACKOFF_MS = 60_000;
const MAX_POLL_BACKOFF_MS = 15 * 60_000;
/** Ceiling on the vendor rate-limit floor (7 days, aligned with the
 * Retry-After parser's clamp): valid long vendor floors are honored in full —
 * the plan's max(exponential, retryAfterMs) — while a buggy or hostile value
 * cannot silence a vendor's polling unboundedly. */
const MAX_RATE_LIMIT_FLOOR_MS = 7 * 24 * 60 * 60_000;

/**
 * Daemon-private persistence for one pacer fact: the per-vendor rate-limit
 * floor. Deliberately OUTSIDE the quota journal and every quota projection
 * (owner decision 7=A): a throttled POLL is pacing state, never quota truth —
 * journaling it as a cooldown would read as "window exhausted" to rotation
 * and to external consumers of the quota surface.
 */
export interface QuotaPacerStateStore {
  /** Millisecond epoch before which the vendor must not be polled; 0 = none. */
  load(vendor: string): number;
  save(vendor: string, notBeforeMs: number): void;
}

/** File-backed store under the daemon dir. Best-effort durability: a missing,
 * corrupt, or unwritable file only forgets the floor (fail-open to polling),
 * it never breaks the poll cycle. */
export function quotaPacerFileStore(dir: string): QuotaPacerStateStore {
  const path = join(dir, "quota-pacer-state.json");
  const read = (): Record<string, { not_before?: unknown }> => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        version?: unknown;
        vendors?: unknown;
      };
      return parsed?.version === 1 &&
        parsed.vendors !== null &&
        typeof parsed.vendors === "object" &&
        !Array.isArray(parsed.vendors)
        ? (parsed.vendors as Record<string, { not_before?: unknown }>)
        : {};
    } catch {
      return {};
    }
  };
  return {
    load(vendor) {
      const iso = read()[vendor]?.not_before;
      const at = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
      return Number.isFinite(at) ? at : 0;
    },
    save(vendor, notBeforeMs) {
      const vendors = read();
      vendors[vendor] = { not_before: new Date(notBeforeMs).toISOString() };
      const tmp = `${path}.tmp.${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, vendors }, null, 2)}\n`);
      renameSync(tmp, path);
    },
  };
}

/**
 * Completion-anchored poll pacing for ONE vendor lane of the quota registry
 * (one instance per vendor with a registered refresher), so a permanently
 * unsatisfiable subject of one vendor can no longer pin every other vendor's
 * refresh cadence at the 15-minute ceiling. Two independent gates:
 *
 * - the credential-demand backoff (`failures`/`notBefore`): in-memory,
 *   exponential per unsatisfied cycle, reset by a credential change — the
 *   pre-existing semantics, now per lane;
 * - the vendor rate-limit floor (`rateLimitedNotBefore`): armed when a cycle
 *   observes a typed `rate_limited` absence for this vendor, honoring the
 *   vendor's Retry-After when known (max with the exponential ladder, 60s
 *   minimum). Persisted through the daemon-private store so a restart is not
 *   a 429 amplifier, and deliberately NOT reset by a credential change —
 *   logging in again does not un-rate-limit the vendor endpoint.
 *
 * Evidence/demand semantics stay with QuotaRegistry; this class owns only
 * scheduling state. Single-flight of the poll sweep also lives in the
 * registry, which drives every lane from one sweep.
 */
export class QuotaPollPacer {
  private failures = 0;
  private notBefore = 0;
  /** Completion instant of the cycle that armed the current retry ladder
   * (0 = no ladder armed). Evidence observed AFTER it was not known to the
   * ladder and may bypass it. */
  private armedAt = 0;
  private rateLimitedNotBefore = 0;
  /** When the active floor was observed (0 = unknown, e.g. store-loaded). */
  private rateLimitedSince = 0;

  constructor(
    private readonly vendor: string | null = null,
    private readonly store?: QuotaPacerStateStore,
  ) {
    if (this.vendor !== null && this.store) {
      try {
        this.rateLimitedNotBefore = this.store.load(this.vendor);
      } catch {
        /* fail-open: a broken store never blocks polling */
      }
    }
  }

  /** Credential/routability change: drop only the credential-demand backoff.
   * The vendor rate-limit floor survives — it is about the vendor endpoint,
   * not about which credentials exist (and a daemon restart or profile toggle
   * must not become a 429 amplifier). */
  noteCredentialChange(): void {
    this.failures = 0;
    this.notBefore = 0;
    this.armedAt = 0;
  }

  /** May the lane poll now? The vendor rate-limit floor is absolute. The retry
   * ladder is not: `renewalDueObservedAt` — the latest observation instant of
   * satisfying evidence whose renewal is due by the next tick — bypasses the
   * ladder when it post-dates the ladder's arm, because that evidence (a
   * foreground refresh, an ingested harness event) was installed after the
   * ladder was armed and the ladder must not postpone its renewal. Evidence
   * the arming cycle itself produced is capped by `armBackoff` instead. */
  pollEligible(now: number, renewalDueObservedAt: number | null = null): boolean {
    if (now < this.rateLimitedNotBefore) return false;
    if (now >= this.notBefore) return true;
    return renewalDueObservedAt !== null && renewalDueObservedAt > this.armedAt;
  }

  /** The active vendor rate-limit floor, or null when none is in effect. */
  rateLimitCooldownUntil(now: number): number | null {
    return now < this.rateLimitedNotBefore ? this.rateLimitedNotBefore : null;
  }

  /** Stable observation stamp for the ACTIVE floor's derived gap rows: the
   * instant the floor was observed. A store-loaded floor (daemon restart)
   * has no recorded observation, so the first read anchors it — stability of
   * the projection signature matters more than the exact historical instant,
   * and the anchor is honest ("known paused since at least then"). */
  rateLimitObservedAt(now: number): number {
    if (this.rateLimitedSince === 0) this.rateLimitedSince = now;
    return this.rateLimitedSince;
  }

  /** A cycle for this lane completed: reset on fully satisfied demand, else
   * exponential backoff anchored at completion (never the stale start) and
   * capped at `renewalNotBefore` — the tick by which evidence this cycle DID
   * satisfy must be renewed. The ladder paces subjects that produced no
   * evidence; it never postpones the renewal of those that did (one revoked or
   * never-logged-in profile used to pin every healthy sibling of its vendor to
   * the 15-minute ceiling). Null = no satisfied evidence is due later. */
  notePollSuccess(
    completedAt: number,
    demandRemains: boolean,
    renewalNotBefore: number | null = null,
  ): void {
    if (!demandRemains) {
      this.failures = 0;
      this.notBefore = 0;
      this.armedAt = 0;
      return;
    }
    this.armBackoff(completedAt, renewalNotBefore);
  }

  notePollFailure(completedAt: number, renewalNotBefore: number | null = null): void {
    this.armBackoff(completedAt, renewalNotBefore);
  }

  /** A cycle observed a typed `rate_limited` absence for this vendor: arm the
   * floor at max(exponential ladder, vendor Retry-After), monotonic, and
   * persist it (a null Retry-After — Anthropic does not always send one —
   * still arms the exponential-derived floor). */
  noteRateLimited(observedAt: number, retryAfterMs: number | null): void {
    const exponential = Math.min(
      POLL_BACKOFF_MS * 2 ** Math.max(this.failures - 1, 0),
      MAX_POLL_BACKOFF_MS,
    );
    const floor = Math.max(exponential, Math.min(retryAfterMs ?? 0, MAX_RATE_LIMIT_FLOOR_MS));
    const until = observedAt + floor;
    if (until <= this.rateLimitedNotBefore) return;
    this.rateLimitedNotBefore = until;
    this.rateLimitedSince = observedAt;
    if (this.vendor !== null) {
      try {
        this.store?.save(this.vendor, until);
      } catch {
        /* fail-open: losing the durable floor only re-allows polling */
      }
    }
  }

  private armBackoff(completedAt: number, renewalNotBefore: number | null): void {
    this.failures += 1;
    this.armedAt = completedAt;
    const ladder =
      completedAt + Math.min(POLL_BACKOFF_MS * 2 ** (this.failures - 1), MAX_POLL_BACKOFF_MS);
    this.notBefore = renewalNotBefore === null ? ladder : Math.min(ladder, renewalNotBefore);
  }
}
