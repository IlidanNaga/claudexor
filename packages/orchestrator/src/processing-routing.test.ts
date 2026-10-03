import { describe, expect, it, vi } from "vitest";
import { processingCostEvidence, prepareReviewerProcessing } from "./processing-routing.js";
import { BudgetLedger, rankHarnesses } from "@claudexor/budget";
import type { PreparedHarnessProcessing } from "@claudexor/core";
import { GlobalConfig } from "@claudexor/schema";
import type { RunInput } from "./orchestrator.js";
import type { ReviewerSpec } from "@claudexor/review";

const prepared = (
  mode: "standard" | "fast",
  kind: "included" | "paid_credits" | "unknown",
): PreparedHarnessProcessing => ({
  model: "exact-model",
  receipt: {
    requested: mode,
    submitted: mode,
    submittedNative: mode,
    observed: "unknown",
    observedNative: [],
    reason: null,
    source: "fixture",
  },
  costBasis: { nativeMode: mode, kind, source: "fixture" },
});
describe("processing cost before ranking and reserve", () => {
  it("keeps omitted native processing on the ordinary billing path", () => {
    const legacy: PreparedHarnessProcessing = {
      model: "exact-model",
      receipt: {
        requested: null,
        submitted: null,
        submittedNative: null,
        observed: "unknown",
        observedNative: [],
        reason: "native_default_unconfirmed",
        source: "fixture",
      },
      costBasis: { nativeMode: null, kind: "unknown", source: "fixture" },
    };
    expect(processingCostEvidence(legacy, "subscription_entitlement", ["legacy"])).toBeUndefined();
  });
  it("keeps an explicit but unclassified native tier unknown", () => {
    const explicit: PreparedHarnessProcessing = {
      model: "exact-model",
      receipt: {
        requested: null,
        submitted: null,
        submittedNative: "scale",
        observed: "unknown",
        observedNative: [],
        reason: "native_explicit",
        source: "fixture",
      },
      costBasis: { nativeMode: "scale", kind: "unknown", source: "fixture" },
    };
    expect(
      processingCostEvidence(explicit, "subscription_entitlement", ["explicit"]),
    ).toMatchObject({
      billing: "unknown",
    });
  });

  it("premium mode outranks auth-only free inference without inventing an estimate", () => {
    const cost = processingCostEvidence(
      prepared("fast", "paid_credits"),
      "subscription_entitlement",
      ["fixture"],
    )!;
    expect(cost).toMatchObject({ billing: "metered", knowledge: "unknown", estimatedUsd: null });
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 0 });
    const candidates = [
      {
        harnessId: "premium",
        available: true,
        authRoute: { route: "vendor_native" as const, verification: "passed" as const },
        costEvidence: cost,
      },
      {
        harnessId: "ordinary",
        available: true,
        authRoute: { route: "vendor_native" as const, verification: "passed" as const },
      },
    ];
    expect(
      rankHarnesses(candidates, {
        goal: "economy",
        paidFallback: "never",
        intent: "implement",
        qualityTiers: {},
        ledger,
      }).map((c) => c.harnessId),
    ).toEqual(["ordinary"]);
    expect(
      ledger.reserve({ taskId: "t", intent: "implement", harnessId: "premium", cost }).denied,
    ).toBe("finite_zero");
    const finite = new BudgetLedger({ kind: "finite", maxUsd: 2 });
    expect(
      finite.reserve({ taskId: "t", intent: "implement", harnessId: "premium", cost }).granted,
    ).toBe(true);
  });
  it("retains verified ordinary included proof only when native Standard was submitted", () => {
    expect(
      processingCostEvidence(prepared("standard", "unknown"), "subscription_entitlement", [
        "verified",
      ])?.billing,
    ).toBe("subscription_entitlement");
    expect(
      processingCostEvidence(prepared("fast", "unknown"), "subscription_entitlement", ["verified"])
        ?.billing,
    ).toBe("unknown");
    expect(
      processingCostEvidence(prepared("standard", "unknown"), "unknown", ["unverified"])?.billing,
    ).toBe("unknown");
  });
  it.each([
    { kind: "finite" as const, maxUsd: 0 },
    { kind: "finite" as const, maxUsd: 2 },
  ])(
    "passes existing paid policy to native preparation before reviewer reservations: %j",
    async (budget) => {
      const prepareProcessing = vi.fn(async (spec: { allowPaid?: boolean }) =>
        prepared(
          spec.allowPaid ? "fast" : "standard",
          spec.allowPaid ? "paid_credits" : "included",
        ),
      );
      const reviewer = {
        adapter: { id: "fixture", prepareProcessing },
        providerFamily: "anthropic",
      } as unknown as ReviewerSpec;
      const input = { processingPreference: "fast", repoRoot: "/fixture" } as RunInput;
      const result = await prepareReviewerProcessing(
        [reviewer],
        input,
        GlobalConfig.parse({ routing: { paid_fallback: "allowed_within_cap" } }),
        budget,
      );
      expect(prepareProcessing).toHaveBeenCalledWith(
        expect.objectContaining({ allowPaid: budget.maxUsd > 0 }),
      );
      expect(result[0]?.processing?.receipt.submitted).toBe(
        budget.maxUsd > 0 ? "fast" : "standard",
      );
    },
  );
});
