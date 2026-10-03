import {
  MAX_DEEP_SCAN_WIDTH_DEFAULT,
  MAX_PARALLEL_CANDIDATES_DEFAULT,
  type ExternalContextPolicy,
  type RuntimeConcurrencyCaps,
} from "@claudexor/schema";
import type { EventLog } from "@claudexor/event-log";
import type { RoutedAdapter, RunInput } from "./orchestrator.js";
import { emitPoolDegraded } from "./runSupport.js";
import { runBounded } from "./run-bounded.js";

/** Width and lane selection for Ask/deep-scan share one requested/effective receipt. */
export async function resolveReadOnlyCandidates(args: {
  input: RunInput;
  prompt: string;
  deepScan: boolean;
  externalContextPolicy: ExternalContextPolicy;
  caps?: RuntimeConcurrencyCaps;
  log: EventLog;
  resolve(input: RunInput, allowDuplicateFill: boolean): Promise<RoutedAdapter[]>;
}): Promise<{ adapters: RoutedAdapter[]; width: number }> {
  const { input, deepScan, externalContextPolicy, caps, log } = args;
  const requested = deepScan
    ? Math.max(input.n ?? 4, 1)
    : externalContextPolicy === "off"
      ? 1
      : Math.min(Math.max(input.n ?? 2, 1), 3);
  const width = deepScan
    ? Math.min(requested, caps?.max_deep_scan_width ?? MAX_DEEP_SCAN_WIDTH_DEFAULT)
    : requested;
  // Deep-scan repeats a surviving harness to reach scout coverage; ordinary
  // Ask is a distinct-harness fallback chain and must never repeat a lane.
  const adapters = await args.resolve({ ...input, prompt: args.prompt, n: width }, deepScan);
  if (!deepScan) {
    const seen = new Set<string>();
    return {
      width,
      adapters: adapters.filter(({ adapter }) => {
        if (seen.has(adapter.id)) return false;
        seen.add(adapter.id);
        return true;
      }),
    };
  }
  if (width < requested) {
    const effectiveHarnesses = [...new Set(adapters.map(({ adapter }) => adapter.id))];
    emitPoolDegraded(log, {
      requestedHarnesses: input.harnesses ?? effectiveHarnesses,
      effectiveHarnesses,
      requestedN: requested,
      effectiveN: width,
      droppedLanes: [],
    });
  }
  return { adapters, width };
}

/** The same configured worker limit governs best-of candidates and deep-scan scouts. */
export function runParallelCandidates<T>(
  items: T[],
  caps: RuntimeConcurrencyCaps | undefined,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  return runBounded(items, caps?.max_parallel_candidates ?? MAX_PARALLEL_CANDIDATES_DEFAULT, work);
}
