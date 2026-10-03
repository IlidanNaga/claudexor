import { newAttemptUsageCost, observeAttemptUsageEvent } from "./attemptUsageCost.js";
import { describe, expect, it, vi } from "vitest";
import { BudgetLedger } from "@claudexor/budget";
import { HarnessRunSpec, type BillingKnowledge, type ProcessingCostBasis } from "@claudexor/schema";
import type { PreparedHarnessProcessing, HarnessAdapter } from "@claudexor/core";
import {
  bindProcessingAdmission,
  updateProcessingStreamHold,
  reviewerProcessingAdmission,
  ProcessingBudgetAdmissionError,
} from "./processing-dispatch.js";
import { processingCostEvidence } from "./processing-routing.js";
import { runModelGovernedRoute } from "./modelGovernance.js";
import type { ReviewerSpec } from "@claudexor/review";

function prepared(kind: ProcessingCostBasis["kind"]): PreparedHarnessProcessing {
  return {
    model: "same-model",
    receipt: {
      requested: "fast",
      submitted: kind === "included" ? "standard" : "fast",
      submittedNative: kind === "included" ? "default" : "priority",
      observed: "unknown",
      observedNative: [],
      reason: null,
      source: "fixture",
    },
    costBasis: {
      nativeMode: kind === "included" ? "default" : "priority",
      kind,
      source: "fixture",
    },
  };
}
function spec(kind: ProcessingCostBasis["kind"]) {
  const p = prepared(kind);
  return HarnessRunSpec.parse({
    session_id: "s",
    intent: "audit",
    prompt: "test",
    cwd: "/fixture",
    model_hint: "same-model",
    processing_preference: "fast",
    processing: p.receipt,
    processing_cost_basis: p.costBasis,
  });
}
function reserve(ledger: BudgetLedger) {
  return ledger.reserve({
    taskId: "t",
    intent: "audit",
    harnessId: "fixture",
    cost: processingCostEvidence(prepared("included"), "unknown", ["fixture"]),
  }).lease!;
}

describe("exact prepared processing before physical dispatch", () => {
  it("refuses changed actual processing before native run while preserving model and effort", async () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 0 });
    const lease = reserve(ledger);
    const input = spec("included");
    input.effort_hint = "high";
    const seen = vi.fn();
    const run = vi.fn(async function* () {
      yield* [];
    });
    const adapter = {
      id: "fixture",
      models: async () => [{ id: "same-model" }],
      prepareProcessing: async () => prepared("paid_credits"),
      run,
    } as unknown as HarnessAdapter;
    const route = {
      adapter,
      knownModels: [],
      authRouteEstimate: "local_session" as const,
      quotaAdmission: { profile: null },
      settings: null,
    };
    bindProcessingAdmission(input, ledger, lease, "fixture", "a01", seen);
    const consume = async () => {
      for await (const _ of runModelGovernedRoute(route, input)) {
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(ProcessingBudgetAdmissionError);
    expect(run).not.toHaveBeenCalled();
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ code: "finite_zero" }));
    expect(input.model_hint).toBe("same-model");
    expect(input.effort_hint).toBe("high");
  });
  it("re-admits allowed rotation and reserves unknown-paid concurrency before native run", async () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const lease = reserve(ledger);
    const input = spec("included");
    const seen: any[] = [];
    const adapter = {
      id: "fixture",
      models: async () => [{ id: "same-model" }],
      prepareProcessing: async () => prepared("paid_credits"),
      run: async function* (actual: HarnessRunSpec) {
        seen.push(actual);
        expect(ledger.reserve({ taskId: "t", intent: "audit", harnessId: "other" }).denied).toBe(
          "unknown_paid_in_flight",
        );
        yield* [];
      },
    } as unknown as HarnessAdapter;
    bindProcessingAdmission(input, ledger, lease, "fixture", "a01");
    for await (const _ of runModelGovernedRoute(
      {
        adapter,
        knownModels: [],
        authRouteEstimate: "local_session",
        quotaAdmission: { profile: null },
        settings: null,
      },
      input,
    )) {
    }
    expect(seen[0].processing.submitted).toBe("fast");
    expect(lease.cost.billing).toBe("metered");
  });
  it("keeps paid panel class when another slot subsequently prepares included service", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 2 });
    const lease = reserve(ledger);
    const reviewers = [0, 1].map(() => ({
      adapter: { id: "fixture" },
      processing: prepared("included"),
    })) as ReviewerSpec[];
    const admit = reviewerProcessingAdmission(ledger, lease.lease_id, reviewers, "a01");
    admit(0, spec("paid_credits"));
    admit(1, spec("included"));
    expect(lease.cost.billing).toBe("metered");
    expect(ledger.reserve({ taskId: "t", intent: "audit", harnessId: "other" }).denied).toBe(
      "unknown_paid_in_flight",
    );
  });
  it.each(["unknown", "metered"] as const)(
    "keeps observed ordinary %s cost when an included slot follows",
    (billing) => {
      const ledger = new BudgetLedger({ kind: "finite", maxUsd: 2 });
      const lease = reserve(ledger);
      const reviewers = [0, 1].map(() => ({ adapter: { id: "fixture" } })) as ReviewerSpec[];
      const admit = reviewerProcessingAdmission(ledger, lease.lease_id, reviewers, "a01");
      admit(0, ordinary(billing));
      admit(1, ordinary("subscription_entitlement"));
      expect(lease.cost.billing).toBe(billing);
      expect(ledger.reserve({ taskId: "t", intent: "audit", harnessId: "other" }).denied).toBe(
        "unknown_paid_in_flight",
      );
    },
  );
  it.each(["unknown", "metered"] as const)(
    "admits an included ordinary row but refuses a later %s row beside an unknown parent",
    (billing) => {
      const ledger = new BudgetLedger({ kind: "finite", maxUsd: 2 });
      expect(
        ledger.reserve({
          taskId: "parent",
          intent: "audit",
          harnessId: "parent",
        }).granted,
      ).toBe(true);
      const lease = reserve(ledger);
      const reviewers = [0, 1].map(() => ({ adapter: { id: "fixture" } })) as ReviewerSpec[];
      const admit = reviewerProcessingAdmission(ledger, lease.lease_id, reviewers, "a01");
      expect(() => admit(0, ordinary("subscription_entitlement"))).not.toThrow();
      expect(() => admit(1, ordinary(billing))).toThrow(ProcessingBudgetAdmissionError);
    },
  );
  it("counts declared paid Processing before its slot is visited", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 2 });
    expect(ledger.reserve({ taskId: "parent", intent: "audit", harnessId: "parent" }).granted).toBe(
      true,
    );
    const lease = reserve(ledger);
    const reviewers = [
      { adapter: { id: "fixture" } },
      { adapter: { id: "fixture" }, processing: prepared("paid_credits") },
    ] as ReviewerSpec[];
    const admit = reviewerProcessingAdmission(ledger, lease.lease_id, reviewers, "a01");
    expect(() => admit(0, ordinary("subscription_entitlement"))).toThrow(
      ProcessingBudgetAdmissionError,
    );
  });
  it.each([
    { kind: "included", amountKind: "valuation", usd: 3, remaining: 1, denied: false },
    { kind: "paid_credits", amountKind: "unknown", usd: 2, remaining: 0, denied: true },
    { kind: "cash", amountKind: "cash", usd: 0.2, remaining: 0.8, denied: false },
  ] as const)(
    "stream hold uses $kind/$amountKind without charging valuation",
    ({ kind, amountKind, usd, remaining, denied }) => {
      const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
      const lease = reserve(ledger);
      const input = spec(kind);
      const usage = newAttemptUsageCost();
      const common = {
        session_id: "s",
        ts: new Date().toISOString(),
        credential_route: "vendor_native" as const,
        processing: input.processing,
        processing_cost_basis: input.processing_cost_basis,
      };
      observeAttemptUsageEvent(usage, { ...common, type: "started" }, null);
      observeAttemptUsageEvent(
        usage,
        {
          ...common,
          type: "usage",
          usage: { cost_usd: usd, cost_basis: { kind: amountKind, source: "fixture" } },
        },
        "local_session",
      );
      expect(
        updateProcessingStreamHold(input, usage, ledger, lease.lease_id, "fixture", "a01") !== null,
      ).toBe(denied);
      expect(ledger.remainingUsd()).toBeCloseTo(remaining);
    },
  );
});

function ordinary(billing: BillingKnowledge): HarnessRunSpec {
  return HarnessRunSpec.parse({
    session_id: "ordinary-review",
    intent: "review",
    prompt: "test",
    cwd: "/fixture",
    credential_profile: {
      profile_id: "review-account",
      harness_id: "fixture",
      display_name: "Review account",
      credential_kind: billing === "metered" ? "api_key" : "config_dir_login",
      isolation_locator: billing === "metered" ? null : "/fixture/profile",
      secret_ref: billing === "metered" ? "openai:review-account" : null,
      enabled: true,
      created_at: null,
    },
    extra: { routeBillingKnowledge: billing },
  });
}
