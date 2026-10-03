import { describe, expect, it } from "vitest";
import type { CostEvidence } from "@claudexor/schema";
import { BudgetLedger } from "./ledger.js";

function cost(billing: CostEvidence["billing"], estimatedUsd: number | null = null): CostEvidence {
  return {
    billing,
    knowledge:
      billing === "subscription_entitlement"
        ? "exact"
        : estimatedUsd === null
          ? "unknown"
          : "estimated",
    estimatedUsd,
    source: "fixture",
    provenance: ["fixture"],
  };
}
function reserve(ledger: BudgetLedger, evidence = cost("subscription_entitlement")) {
  return ledger.reserve({ taskId: "t", intent: "implement", harnessId: "fixture", cost: evidence })
    .lease!;
}

describe("physical processing readmission on one logical lease", () => {
  it("refuses newly paid processing at finite zero without changing the old lease", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 0 });
    const lease = reserve(ledger);
    expect(ledger.repriceReservedLease(lease.lease_id, cost("metered"))).toMatchObject({
      granted: false,
      denied: "finite_zero",
    });
    expect(lease.cost.billing).toBe("subscription_entitlement");
  });
  it("checks other unknown-paid work and does not collide with its own paid lease", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const first = reserve(ledger);
    const paid = reserve(ledger, cost("unknown"));
    expect(ledger.repriceReservedLease(first.lease_id, cost("metered"))).toMatchObject({
      granted: false,
      denied: "unknown_paid_in_flight",
    });
    expect(ledger.repriceReservedLease(paid.lease_id, cost("metered")).granted).toBe(true);
    ledger.cancel(paid.lease_id);
    expect(ledger.repriceReservedLease(first.lease_id, cost("metered")).granted).toBe(true);
    expect(ledger.reserve({ taskId: "t", intent: "review", harnessId: "other" }).denied).toBe(
      "unknown_paid_in_flight",
    );
  });
  it("holds streamed prior work plus the new physical quote, then settles only once", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const lease = reserve(ledger, cost("metered", 0.1));
    ledger.updateHold(lease.lease_id, 0.35);
    expect(ledger.repriceReservedLease(lease.lease_id, cost("metered", 0.4)).granted).toBe(true);
    expect(ledger.remainingUsd()).toBeCloseTo(0.25);
    expect(ledger.repriceReservedLease(lease.lease_id, cost("metered", 0.7)).denied).toBe(
      "estimate_headroom",
    );
    expect(ledger.remainingUsd()).toBeCloseTo(0.25);
    ledger.settle(lease.lease_id, {
      knowledge: "exact",
      cashKnowledge: "exact",
      cashUsd: 0.65,
      source: "fixture",
      provenance: [],
    });
    expect(ledger.spend()).toBeCloseTo(0.65);
    expect(ledger.remainingUsd()).toBeCloseTo(0.35);
  });
  it("preserves prior unknown-paid debt when the next physical send is included", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 2 });
    const lease = reserve(ledger, cost("unknown"));
    ledger.updateHold(lease.lease_id, 0.25);
    ledger.markPhysicalDispatchStarted(lease.lease_id);
    expect(
      ledger.repriceReservedLease(lease.lease_id, cost("subscription_entitlement")).granted,
    ).toBe(true);
    expect(ledger.remainingUsd()).toBeCloseTo(1.75);
    expect(ledger.reserve({ taskId: "t", intent: "review", harnessId: "other" }).denied).toBe(
      "unknown_paid_in_flight",
    );
  });
  it("allows included continuation beyond cash cap without erasing prior unknown settlement", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const lease = reserve(ledger, cost("unknown"));
    ledger.updateHold(lease.lease_id, 1.5);
    ledger.markPhysicalDispatchStarted(lease.lease_id);
    expect(
      ledger.repriceReservedLease(lease.lease_id, cost("subscription_entitlement")).granted,
    ).toBe(true);
    ledger.settle(lease.lease_id, {
      knowledge: "unknown",
      source: "prior-amount-missing",
      provenance: [],
    });
    expect(ledger.terminal()).toBe("cost_unverifiable");
  });
  it("clears unknown preflight debt when included before physical dispatch", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 2 });
    const lease = reserve(ledger, cost("unknown"));
    expect(
      ledger.repriceReservedLease(lease.lease_id, cost("subscription_entitlement")).granted,
    ).toBe(true);
    expect(ledger.reserve({ taskId: "t", intent: "review", harnessId: "other" }).granted).toBe(
      true,
    );
  });
  it("preserves family scope and rejects repricing a closed lease", () => {
    const ledger = new BudgetLedger();
    const lease = reserve(ledger);
    expect(() =>
      ledger.scopedToTask("other").repriceReservedLease(lease.lease_id, cost("metered")),
    ).toThrow();
    ledger.cancel(lease.lease_id);
    expect(() => ledger.repriceReservedLease(lease.lease_id, cost("metered"))).toThrow(/closed/);
  });
});
