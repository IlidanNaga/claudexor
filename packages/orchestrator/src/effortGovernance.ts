import type { EffortHint } from "@claudexor/schema";

export interface EffortGovernedRoute {
  id: string;
  effortLevels: readonly EffortHint[];
}

/** Discovery describes the default account, not necessarily the selected one.
 * Preserve the preference until the adapter resolves the final native route.
 * Unsupported knobs are disclosed there, without erasing the original request. */
export function governRouteEffort(
  requested: EffortHint | null,
  _route: EffortGovernedRoute,
): { effort: EffortHint | null; ignored: string | null } {
  return { effort: requested, ignored: null };
}
