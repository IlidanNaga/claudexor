import type { HarnessCapabilities, ModelInventoryAbsence } from "@claudexor/schema";
import type { HarnessAdapter } from "./adapter.js";

/** A route-scoped producer is queried only for a known supported route.
 * Undeclared producers retain legacy behavior; failed producers never fall back. */
export function hasModelInventoryForRoute(
  adapter: Pick<HarnessAdapter, "models">,
  declaredRoutes: Readonly<HarnessCapabilities["model_inventory_routes"]>,
  route: "local_session" | "api_key" | null,
): adapter is Pick<HarnessAdapter, "models"> & Required<Pick<HarnessAdapter, "models">> {
  return (
    typeof adapter.models === "function" &&
    (declaredRoutes === undefined || (route !== null && declaredRoutes.includes(route)))
  );
}

/**
 * Validate a requested/configured model id against a harness's model truth
 * source — the model analog of the effort normalizer (`normalizeEffort`).
 * Data-driven: the caller supplies the truth list (live `models()` inventory
 * or manifest `known_models`); this never hardcodes a model list in logic.
 *
 * A live list always proves PRESENCE. It proves ABSENCE only where its producer
 * declares that it can (`model_inventory_absence`, INV-104), and the manifest
 * list always speaks for itself — so the strict path below is unchanged for
 * every harness except a live producer that declared `advisory`:
 * - no model requested (null/empty) → ok (the harness default is used).
 * - truth list empty → rejected: the harness cannot verify models, so an
 *   EXPLICIT model is refused with actionable text instead of being forwarded
 *   to the vendor CLI to die as an opaque native error.
 * - requested ∈ list → ok.
 * - requested ∉ list → rejected, naming the truth source and the list.
 *
 * ADVISORY live inventory (owner-approved 2026-09-21): a miss and an empty list
 * are both `ok` with an `unverified` note. The gate decides nothing it cannot
 * prove; the explicit model travels to the vendor unchanged and the vendor
 * accepts or refuses it. No other list is consulted — the manifest is never
 * substituted to admit a model.
 */
export type ModelCheckStatus = "ok" | "rejected";
export interface ModelCheck {
  status: ModelCheckStatus;
  message: string | null;
  /** True only on an `ok` the truth source could not actually verify: the
   * model was forwarded because absence was unprovable. Callers that can
   * disclose (the per-spawn gate) say so once; nothing depends on it to run. */
  unverified?: boolean;
}

/** Where the truth list came from; used to phrase actionable refusals. */
export type ModelTruthSource = "api" | "manifest";

/** The note a forwarded (unverifiable) model carries. One sentence, frozen:
 * what the list said, why it cannot refuse, and what happens instead. */
const UNPROVABLE_ABSENCE =
  "this harness's list cannot prove a model is absent, so the request is forwarded to the vendor";

export function validateModel(
  requested: string | null | undefined,
  known: readonly string[],
  source: ModelTruthSource = "manifest",
  absence: ModelInventoryAbsence = "authoritative",
): ModelCheck {
  const model = typeof requested === "string" ? requested.trim() : "";
  if (!model) return { status: "ok", message: null };
  // Only a LIVE producer can be advisory: the manifest list is this repo's own
  // declaration and always speaks for itself.
  const advisory = source === "api" && absence === "advisory";
  if (known.length === 0) {
    if (advisory) {
      return {
        status: "ok",
        message: `the harness returned no model list; ${UNPROVABLE_ABSENCE}`,
        unverified: true,
      };
    }
    return {
      status: "rejected",
      message:
        `this harness cannot verify models (no ${source === "api" ? "live model inventory" : "manifest known_models"}); ` +
        (source === "api"
          ? "repair the live account/auth route or use the harness default (omit the model)"
          : "use the harness default (omit the model) or add known_models to the manifest"),
    };
  }
  if (known.includes(model)) return { status: "ok", message: null };
  if (advisory) {
    return {
      status: "ok",
      message: `model "${model}" is not in this account's listed models; ${UNPROVABLE_ABSENCE}`,
      unverified: true,
    };
  }
  const shown = known.slice(0, 80).join(", ");
  const suffix = known.length > 80 ? `, ... (${known.length} total)` : "";
  return {
    status: "rejected",
    message: `model "${model}" is not in the harness's ${source === "api" ? "live model inventory" : "manifest known-model list"} (${shown}${suffix})`,
  };
}
