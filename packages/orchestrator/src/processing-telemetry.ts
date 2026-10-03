import type { HarnessEvent, ProcessingCostBasis, ProcessingReceipt } from "@claudexor/schema";

export interface ProcessingTelemetry {
  processing?: ProcessingReceipt;
  processingCostBasis?: ProcessingCostBasis;
  processingIntervals?: ProcessingReceipt[];
  currentProcessing?: ProcessingReceipt;
}

/** Adapters own each native session's observations. Preserve completed native
 * retry intervals as well, so a later ordinary run cannot erase paid/mixed work. */
export function observeProcessing(t: ProcessingTelemetry, event: HarnessEvent): void {
  if (event.type === "started")
    t.currentProcessing = t.processing
      ? { ...t.processing, observed: "unknown", observedNative: [] }
      : undefined;
  if (event.processing) t.currentProcessing = event.processing;
  if (event.processing_cost_basis) t.processingCostBasis = event.processing_cost_basis;
  const current = t.currentProcessing;
  if (!current) return;
  const all = [...(t.processingIntervals ?? []), current];
  const modes = new Set(all.map((receipt) => receipt.observed));
  t.processing = {
    ...current,
    observedNative: [...new Set(all.flatMap((receipt) => receipt.observedNative))],
    observed:
      modes.has("mixed") || [...modes].filter((mode) => mode !== "unknown").length > 1
        ? "mixed"
        : modes.has("unknown")
          ? "unknown"
          : current.observed,
  };
  if (event.type === "completed") {
    (t.processingIntervals ??= []).push(current);
    t.currentProcessing = undefined;
  }
}
