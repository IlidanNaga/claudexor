#!/usr/bin/env node
/**
 * Opt-in journal preparation benchmark (not part of CI).
 *
 *   node scripts/journal-bench.mjs --root <journal root dir> --partition <name> [--fold none|heavy]
 *
 * Runs `DurableJournal.prepare` (read-only; the root is never written) with the
 * built package and prints wall time, `process.memoryUsage()` and max RSS.
 * `--fold heavy` applies a demo policy — keep only the newest record per type
 * and drop `run.event` records — to measure fold-at-replay memory; it is NOT
 * the daemon's retention policy. Run `pnpm build` first.
 */
import { performance } from "node:perf_hooks";
import { DurableJournal, keepEverything } from "../packages/journal/dist/index.js";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const rootDir = args.get("--root");
const partition = args.get("--partition") ?? "global";
const foldName = args.get("--fold") ?? "none";
if (!rootDir) {
  console.error("usage: journal-bench.mjs --root <dir> --partition <name> [--fold none|heavy]");
  process.exit(2);
}

const folds = {
  none: keepEverything,
  heavy: {
    verdict(record) {
      if (record.type === "run.event") return { drop: true };
      return { slot: `type/${record.type}` };
    },
  },
};
const fold = folds[foldName];
if (!fold) {
  console.error(`unknown fold '${foldName}' (none|heavy)`);
  process.exit(2);
}

const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const snapshot = (label) => {
  const usage = process.memoryUsage();
  console.log(
    `${label}: heapUsed=${megabytes(usage.heapUsed)} external=${megabytes(usage.external)} rss=${megabytes(usage.rss)}`,
  );
};

snapshot("start");
const started = performance.now();
const journal = DurableJournal.prepare({
  rootDir,
  partition,
  fold,
  deferCompaction: true,
  compactionThresholdBytes: Number.MAX_SAFE_INTEGER,
});
const elapsed = performance.now() - started;
try {
  const state = journal.state();
  console.log(
    `prepare: ${(elapsed / 1000).toFixed(2)} s, status=${state.status}, bytes=${journal.physicalBytes()}, currentSequence=${state.status === "ready" ? journal.currentSequence() : "n/a"}`,
  );
  snapshot("after prepare");
  if (state.status === "ready") {
    // records() clones every retained payload: measured separately on purpose.
    console.log(`retained records: ${journal.records().length}`);
    snapshot("after records() clone");
  }
} finally {
  journal.close();
}
// process.resourceUsage().maxRSS is reported in kibibytes.
console.log(`max RSS: ${megabytes(process.resourceUsage().maxRSS * 1024)}`);
