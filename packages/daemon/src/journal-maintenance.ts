import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { DurableJournal, JournalCompactionOutcome } from "@claudexor/journal";
import { ensureCanonicalPrivateDirectory } from "@claudexor/util";

/** One cancelable maintenance flight under the daemon's existing root writer.
 * A manager creates a new journal object per generation and closes the old one;
 * those exact objects are the dedupe keys, never another durable authority. */
export class JournalMaintenance {
  private readonly pending = new Set<DurableJournal>();
  private readonly controller = new AbortController();
  private flight: Promise<void> | null = null;
  private armed = false;
  private stopped = false;
  private cleaned = false;
  private readonly stagingDir: string;

  constructor(
    rootDir: string,
    /** One sink for failures, typed declines and `journal.records_retired`
     * receipts (the daemon log plus startup diagnostics in the composition root). */
    private readonly log: (message: string) => void,
  ) {
    this.stagingDir = join(rootDir, "journal-compaction");
  }

  /** Request one pass for this generation. Requests coalesce while pending; a
   * request that arrives during the generation's own flight runs one more pass
   * after it — the journal's threshold hook is edge-triggered, so that request
   * means the file crossed the threshold again. */
  request = (journal: DurableJournal): void => {
    if (this.stopped) return;
    this.pending.add(journal);
    this.startFlight();
  };

  /** Called only after normal admission, including recovery-route reopen. */
  arm(): void {
    if (this.armed || this.stopped) return;
    try {
      // A sibling of journal/, so candidate churn never changes a concurrently
      // prepared partition's journal-root directory fingerprint.
      ensureCanonicalPrivateDirectory(this.stagingDir);
      this.armed = true;
      this.startFlight();
    } catch (error) {
      this.warnFailure(error);
    }
  }

  /** Synchronous prefix revokes new work and aborts bulk I/O. The existing
   * daemon stop wrapper awaits cleanup before journals/root authority close. */
  stop(): Promise<void> {
    this.stopped = true;
    this.pending.clear();
    this.controller.abort();
    return this.flight ?? Promise.resolve();
  }

  private startFlight(): void {
    if (!this.armed || this.stopped || this.flight) return;
    const flight = this.run()
      .catch((error: unknown) => {
        if (!this.controller.signal.aborted) this.warnFailure(error);
      })
      .finally(() => {
        if (this.flight === flight) this.flight = null;
        if (this.pending.size > 0) this.startFlight();
      });
    this.flight = flight;
  }

  private async run(): Promise<void> {
    await setImmediate(undefined, { signal: this.controller.signal });
    if (!this.cleaned) {
      this.cleaned = true;
      await this.removeCrashCandidates();
    }
    while (!this.stopped && this.pending.size > 0) {
      const journal = this.pending.values().next().value!;
      this.pending.delete(journal);
      try {
        if (journal.state().status !== "ready") continue;
      } catch {
        continue;
      } // the manager retired this exact generation
      try {
        const outcome = await journal.compactInBackground({
          stagingDir: this.stagingDir,
          signal: this.controller.signal,
        });
        const line = describeCompactionOutcome(
          journal.options.partition,
          outcome,
          journal.retiredAtReplay(),
        );
        if (line) this.log(line);
      } catch (error) {
        this.warnFailure(error);
      }
    }
  }

  private async removeCrashCandidates(): Promise<void> {
    for (const name of await readdir(this.stagingDir)) {
      this.controller.signal.throwIfAborted();
      // Only this producer's UUID-shaped scratch files, never journal.bin,
      // append.pending.json, recovery receipts, archives or unrelated entries.
      if (!/^journal-compaction-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.compact$/.test(name))
        continue;
      const path = join(this.stagingDir, name);
      const stat = await lstat(path);
      if (stat.isFile() && stat.nlink === 1) await unlink(path);
    }
  }

  private warnFailure(error: unknown): void {
    this.log(
      `journal maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The process footprint as log-line fields (`rssMb=… heapUsedMb=… externalMb=…`,
 * whole mebibytes). The daemon's retained journal set lives on its heap, so
 * the lines that already exist — the normal-admission line and every journal
 * maintenance receipt — carry it, and the memory class stays observable on
 * every install without a new mechanism. */
export function processMemoryFields(
  usage: Pick<NodeJS.MemoryUsage, "rss" | "heapUsed" | "external"> = process.memoryUsage(),
): string {
  const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  return `rssMb=${mb(usage.rss)} heapUsedMb=${mb(usage.heapUsed)} externalMb=${mb(usage.external)}`;
}

/** One log line per maintenance outcome: the typed decline with its reason and
 * bounds, or the `journal.records_retired` receipt — compaction-time counts
 * beside what the fold already retired while replaying this generation at
 * open (`retiredAtReplay`). Both end with the process memory fields. The quiet
 * no-ops (below the threshold, an empty journal) produce no line. */
export function describeCompactionOutcome(
  partition: string,
  outcome: JournalCompactionOutcome,
  replay: { count: number; bytes: number } = { count: 0, bytes: 0 },
  memory: string = processMemoryFields(),
): string | null {
  if ("declined" in outcome) {
    if (outcome.reason === "below_threshold" || outcome.reason === "empty") return null;
    const bounds: string[] = [];
    if (outcome.compressedBytes !== undefined)
      bounds.push(`compressedBytes=${outcome.compressedBytes}`);
    // Only a capacity decline names a cap that fired; a no-reclaim decline's
    // cap is the current file size, which `compressedBytes` already exceeds.
    if (outcome.reason === "capacity" && outcome.cap !== undefined)
      bounds.push(`cap=${outcome.cap}`);
    return ["journal.compaction_declined", `partition=${partition}`, `reason=${outcome.reason}`]
      .concat(bounds, memory)
      .join(" ");
  }
  return [
    "journal.records_retired",
    `partition=${partition}`,
    `retainedCount=${outcome.retainedCount}`,
    `retiredCount=${outcome.retiredCount}`,
    `retiredBytes=${outcome.retiredBytes}`,
    `retiredAtReplayCount=${replay.count}`,
    `retiredAtReplayBytes=${replay.bytes}`,
    `beforeBytes=${outcome.beforeBytes}`,
    `afterBytes=${outcome.afterBytes}`,
    memory,
  ].join(" ");
}
