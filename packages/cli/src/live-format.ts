/** Bounded string/lane helpers for the live event formatter (split out of
 * live.ts at the 600-line complexity-ratchet cap). */

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
}

/**
 * Lane key for per-attempt dedup state — the same pair the line renders,
 * bounded so a pathological id never bloats the map (confirm review, minor).
 */
export function laneOf(p: Record<string, unknown>): string {
  return truncate([p["attempt_id"], p["harness_id"]].filter(Boolean).join("/"), 256);
}
