import { z } from "zod/v3";

/** Physical transport evidence, separate from a model's token/context window. */
const InputMeasure = z.object({
  scope: z
    .literal("turn_text")
    .describe("All text input items in one native turn; separate instructions are excluded."),
  unit: z.literal("unicode_scalars"),
  limit: z.number().int().positive().safe(),
  source: z.string().min(1),
});

export const HarnessInputLimit = InputMeasure.extend({
  verified_against: z
    .string()
    .min(1)
    .describe("Native runtime version against which the bound was observed."),
}).describe(
  "Adapter-owned observed input bound, not a predictive refusal or a model-window claim.",
);
export type HarnessInputLimit = z.infer<typeof HarnessInputLimit>;

export const HarnessRequestRefusal = InputMeasure.extend({
  kind: z.literal("input_too_large"),
  limit: z.number().int().positive().safe().nullable(),
  actual: z.number().int().nonnegative().safe().nullable(),
  native_code: z.string().min(1),
}).describe(
  "Vendor-typed physical input refusal; the same input cannot be repaired by changing this harness's account or model.",
);
export type HarnessRequestRefusal = z.infer<typeof HarnessRequestRefusal>;

export const CatalogInputLimit = HarnessInputLimit.extend({
  askPromptBudget: z
    .object({
      shape: z
        .literal("ordinary_initial_attempt")
        .describe(
          "Ordinary ASK initial attempt, including thread-turn continuity; excludes deep-scan and automatic continuation attempts.",
        ),
      engineOverheadMax: z.number().int().nonnegative().safe(),
    })
    .optional(),
});
export type CatalogInputLimit = z.infer<typeof CatalogInputLimit>;
