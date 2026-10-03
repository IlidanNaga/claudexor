import { effortJsonSchema, ProcessingPreference } from "@claudexor/schema";

export const processingPreferenceSchema = {
  type: "string",
  enum: ProcessingPreference.options,
  description:
    "Advisory service preference; omission inherits captured settings and explicit Standard requests ordinary service.",
};

export const reviewerPanelEntrySchema = {
  harness: { type: "string", minLength: 1 },
  model: { type: "string", minLength: 1 },
  effort: effortJsonSchema("Effort for this reviewer entry."),
  processingPreference: processingPreferenceSchema,
  credentialProfileId: {
    type: "string",
    minLength: 1,
    description: "Optional strict credential profile id; absent uses the canonical account pool.",
  },
};
