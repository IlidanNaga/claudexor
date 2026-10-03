import type { DurableJournal, DurableJournalOptions } from "@claudexor/journal";
import { journalFoldPolicy } from "./journal-fold-policy.js";

/**
 * The daemon's journal options for one manager: every partition replays and
 * compacts through the daemon fold policy (one frozen policy shared by every
 * manager and every pass), opts into deferred maintenance
 * whenever a maintenance callback exists, and re-requests maintenance for the
 * live generation when an append crosses the compaction threshold — the
 * journal fires that hook once per crossing and re-arms it when the pass
 * settles (install, typed decline or a failed pass).
 */
export function daemonJournalOptions(input: {
  rootDir: string;
  partition: string;
  now: () => Date;
  requestMaintenance: ((journal: DurableJournal) => void) | undefined;
  current: () => DurableJournal | null;
}): DurableJournalOptions {
  return {
    rootDir: input.rootDir,
    partition: input.partition,
    now: input.now,
    deferCompaction: input.requestMaintenance !== undefined,
    fold: journalFoldPolicy,
    onCompactionThreshold: () => {
      const journal = input.current();
      if (journal) input.requestMaintenance?.(journal);
    },
  };
}
