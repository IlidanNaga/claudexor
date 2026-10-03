import { z } from "zod/v3";
import { Id } from "./primitives.js";

/**
 * How a caller ADDRESSES the daemon's retained product commands.
 *
 * The unqualified read (no query, or an empty one) still returns every retained
 * product command — the daemon's historical behavior. A qualified read names
 * exactly ONE subject, and the daemon selects it BEFORE the public projection
 * runs, so an addressed read never redacts, traverses, or serializes the params
 * of unrelated runs:
 *
 * - `id` — one run, matched on the job id OR the bound run id, the same rule
 *   the control plane's run lookup applies. A miss is an empty selection, not
 *   an error: absence is the caller's answer to report, never a transport fact.
 * - `delegatedFromRunId` — the bounded, deterministically ordered direct
 *   Delegate children of one parent run (`MAX_DELEGATED_CHILDREN`).
 *
 * The two are mutually exclusive: a query carrying both addresses no single
 * subject and is refused at the RPC boundary instead of silently preferring
 * one (INV-021). An engine that predates this query ignores it and answers with
 * the full list, so every caller re-applies its own selection on the result and
 * a version skew costs work, never correctness.
 */
export const CommandListQuery = z
  .object({
    id: Id.optional().describe("Select the single command whose job id or run id equals this."),
    delegatedFromRunId: Id.optional().describe(
      "Select the bounded direct Delegate children of this parent run id.",
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.id !== undefined && value.delegatedFromRunId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a command list query addresses either one id or one Delegate parent, never both",
      });
    }
  })
  .describe("Addressed selection for the daemon's retained product command list.");
export type CommandListQuery = z.infer<typeof CommandListQuery>;
