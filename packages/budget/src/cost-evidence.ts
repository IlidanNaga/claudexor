import type { BillingKnowledge, CostEvidence, CostKnowledge } from "@claudexor/schema";
import { CostEvidence as CostEvidenceSchema } from "@claudexor/schema";

export const UNKNOWN_COST: CostEvidence = {
  knowledge: "unknown",
  billing: "unknown",
  source: "route_preflight",
  provenance: ["route:billing-unknown"],
  estimatedUsd: null,
};

export function routeCostEvidence(input: {
  billing?: BillingKnowledge;
  knowledge?: CostKnowledge;
  source: string;
  provenance: string[];
  estimatedUsd?: number | null;
}): CostEvidence {
  return CostEvidenceSchema.parse({
    billing: input.billing ?? "unknown",
    knowledge: input.knowledge ?? "unknown",
    source: input.source,
    provenance: input.provenance,
    estimatedUsd: input.estimatedUsd ?? null,
  });
}

export function attemptCostEvidence(
  harnessId: string,
  attemptId: string,
  estimatedUsd?: number,
  billing: BillingKnowledge = "unknown",
  processingCost?: CostEvidence,
): CostEvidence {
  if (processingCost)
    return CostEvidenceSchema.parse({
      ...processingCost,
      estimatedUsd: processingCost.estimatedUsd ?? estimatedUsd ?? null,
      knowledge:
        processingCost.knowledge === "unknown" && estimatedUsd !== undefined
          ? "estimated"
          : processingCost.knowledge,
      provenance: [...processingCost.provenance, `attempt:${attemptId}`],
    });
  return routeCostEvidence({
    source: "route-preflight",
    provenance: [`harness:${harnessId}`, `attempt:${attemptId}`, `billing:${billing}`],
    billing,
    knowledge: estimatedUsd === undefined ? "unknown" : "estimated",
    estimatedUsd: estimatedUsd ?? null,
  });
}
