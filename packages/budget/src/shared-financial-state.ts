import type { BudgetLease, CostKnowledge, PaidBudget } from "@claudexor/schema";
import type { CircuitThresholds } from "./ledger.js";

export interface TaskFinancialTotals {
  cashUsd: number;
  valuationUsd: number;
  cashEstimated: boolean;
  cashKnowledge: CostKnowledge | null;
  valuationKnowledge: CostKnowledge | null;
}

export interface SharedFinancialState {
  budget: PaidBudget;
  thresholds: CircuitThresholds;
  leases: Map<string, BudgetLease>;
  holds: Map<string, { reservedUsd: number; observedUsd: number }>;
  unknownPaidInFlight: Set<string>;
  physicalDispatchStarted: Set<string>;
  totalsByTask: Map<string, TaskFinancialTotals>;
  cashUsd: number;
  valuationUsd: number;
  cashEstimated: boolean;
  cashKnowledge: CostKnowledge | null;
  valuationKnowledge: CostKnowledge | null;
  overshot: boolean;
  unverifiable: boolean;
  rootOnCashSettled?: (
    cashSpendUsd: number,
    valuationUsd: number,
    cashEstimated: boolean,
    valuationKnowledge: CostKnowledge,
    cashKnowledge: CostKnowledge,
  ) => void;
}

export function newSharedFinancialState(
  budget: PaidBudget,
  thresholds: CircuitThresholds,
  rootOnCashSettled?: (
    cashSpendUsd: number,
    valuationUsd: number,
    cashEstimated: boolean,
    valuationKnowledge: CostKnowledge,
    cashKnowledge: CostKnowledge,
  ) => void,
): SharedFinancialState {
  return {
    budget,
    thresholds,
    leases: new Map(),
    holds: new Map(),
    unknownPaidInFlight: new Set(),
    physicalDispatchStarted: new Set(),
    totalsByTask: new Map(),
    cashUsd: 0,
    valuationUsd: 0,
    cashEstimated: false,
    cashKnowledge: null,
    valuationKnowledge: null,
    overshot: false,
    unverifiable: false,
    rootOnCashSettled,
  };
}

export function recordSharedSettlement(
  financial: SharedFinancialState,
  taskTotals: TaskFinancialTotals,
  cashUsd: number,
  valuationUsd: number,
  cashKnowledge: CostKnowledge,
  valuationKnowledge: CostKnowledge | null,
): void {
  financial.cashUsd += cashUsd;
  financial.valuationUsd += valuationUsd;
  taskTotals.cashUsd += cashUsd;
  taskTotals.valuationUsd += valuationUsd;
  taskTotals.cashKnowledge = mergeKnowledge(taskTotals.cashKnowledge, cashKnowledge);
  financial.cashKnowledge = mergeKnowledge(financial.cashKnowledge, cashKnowledge);
  taskTotals.cashEstimated = taskTotals.cashKnowledge !== "exact";
  financial.cashEstimated = financial.cashKnowledge !== "exact";
  if (valuationKnowledge !== null) {
    taskTotals.valuationKnowledge = mergeKnowledge(
      taskTotals.valuationKnowledge,
      valuationKnowledge,
    );
    financial.valuationKnowledge = mergeKnowledge(financial.valuationKnowledge, valuationKnowledge);
  }
  financial.rootOnCashSettled?.(
    financial.cashUsd,
    financial.valuationUsd,
    financial.cashEstimated,
    financial.valuationKnowledge ?? "unknown",
    financial.cashKnowledge ?? "unknown",
  );
}

export function taskFinancialTotals(
  financial: SharedFinancialState,
  taskId: string,
): TaskFinancialTotals {
  let totals = financial.totalsByTask.get(taskId);
  if (!totals) {
    totals = {
      cashUsd: 0,
      valuationUsd: 0,
      cashEstimated: false,
      cashKnowledge: null,
      valuationKnowledge: null,
    };
    financial.totalsByTask.set(taskId, totals);
  }
  return totals;
}

export function settlementIsEstimated(
  financial: SharedFinancialState,
  taskScope: string | null,
): boolean {
  return taskScope === null
    ? financial.cashEstimated
    : (financial.totalsByTask.get(taskScope)?.cashEstimated ?? false);
}

export function settlementValuationKnowledge(
  financial: SharedFinancialState,
  taskScope: string | null,
): CostKnowledge {
  return taskScope === null
    ? (financial.valuationKnowledge ?? "unknown")
    : (financial.totalsByTask.get(taskScope)?.valuationKnowledge ?? "unknown");
}

function mergeKnowledge(current: CostKnowledge | null, incoming: CostKnowledge): CostKnowledge {
  if (current === null) return incoming;
  if (current === "unknown" || incoming === "unknown") return "unknown";
  if (current === "estimated" || incoming === "estimated") return "estimated";
  return "exact";
}
