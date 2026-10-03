import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPACTED_SNAPSHOT, replayFrames } from "./frame-codec.js";
import { readFrames } from "./frame-reader.js";
import {
  DurableJournal,
  keepEverything,
  type DurableJournalOptions,
  type JournalFold,
} from "./index.js";

// Small chunks so a few kilobytes of history span several snapshot frames.
vi.mock("./frame-codec.js", async (original) => ({
  ...(await original<typeof import("./frame-codec.js")>()),
  SNAPSHOT_CHUNK_LOGICAL_BYTES: 4096,
}));

let root: string;
let stagingDir: string;
const journals: DurableJournal[] = [];
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "journal-fold-replay-")));
  stagingDir = join(root, "staging");
  mkdirSync(stagingDir, { mode: 0o700 });
});
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  rmSync(root, { recursive: true, force: true });
});

function open(extra: Partial<DurableJournalOptions> = {}, prepare = false): DurableJournal {
  const options: DurableJournalOptions = {
    rootDir: join(root, "journal"),
    partition: "global",
    now: () => new Date("2026-01-01T00:00:00Z"),
    deferCompaction: true,
    compactionThresholdBytes: 0,
    ...extra,
  };
  const journal = prepare ? DurableJournal.prepare(options) : new DurableJournal(options);
  journals.push(journal);
  return journal;
}

function seed(count: number): { path: string; epoch: string } {
  const journal = open();
  journal.appendBatch(
    Array.from({ length: count }, (_, n) => ({
      type: n % 4 === 0 ? "latest" : "history",
      payload: { n, text: "payload ".repeat(32) },
    })),
  );
  const epoch = journal.currentEpoch();
  journal.close();
  return { path: journal.path, epoch };
}

const dropHistory: JournalFold = {
  verdict: (record) => ({
    drop: record.type === "history",
    slot: record.type === "latest" ? "latest" : undefined,
  }),
};

function snapshotFrameCount(path: string): number {
  const replay = replayFrames(readFileSync(path), "global");
  expect(replay.error).toBeNull();
  const fd = openSync(path, "r");
  try {
    const positional = readFrames(fd, "global");
    expect(positional.retained).toEqual(replay.records);
  } finally {
    closeSync(fd);
  }
  return new Set(
    replay.records.filter((record) => record.byteOffset >= 0).map((record) => record.frameHash),
  ).size;
}

describe("fold at replay", () => {
  it("prepares the retained set with epoch/seq/chain from the disk, then appends and reopens cleanly", () => {
    const seeded = seed(40);
    const path = seeded.path;
    const prepared = open({ fold: dropHistory }, true);
    // Only the LAST `latest` record survives; the final frame on disk (n=39, history) is dropped.
    expect(prepared.records().map((record) => record.seq)).toEqual([37]);
    expect(prepared.currentSequence()).toBe(40);
    expect(prepared.currentEpoch()).toBe(seeded.epoch);
    prepared.activatePrepared();
    expect(prepared.records().map((record) => record.seq)).toEqual([37]);
    expect(prepared.currentSequence()).toBe(40);
    const appended = prepared.append("after.fold", { ok: true });
    expect(appended.seq).toBe(41);
    expect(appended.previousFrameHash).toBe(
      replayFrames(readFileSync(path), "global").records[39]!.frameHash,
    );
    prepared.close();
    const reopened = open();
    expect(reopened.state().status).toBe("ready");
    expect(reopened.currentSequence()).toBe(41);
    expect(reopened.records().at(-1)).toMatchObject({ seq: 41, type: "after.fold" });
    const refolded = open({ fold: dropHistory });
    expect(refolded.records().map((record) => record.seq)).toEqual([37, 41]);
  });

  it("keeps a direct writer's chain intact when the fold drops the last frame", () => {
    seed(8);
    const folded = open({ fold: { verdict: () => ({ drop: true }) } });
    expect(folded.records()).toEqual([]);
    expect(folded.currentSequence()).toBe(8);
    expect(folded.append("one", 1).seq).toBe(9);
    expect(folded.append("two", 2).seq).toBe(10);
    folded.close();
    const reopened = open();
    expect(reopened.state().status).toBe("ready");
    expect(reopened.records().map((record) => record.seq)).toEqual(
      [...Array(8).keys()].map((n) => n + 1).concat(9, 10),
    );
  });

  it("writes a multi-frame seq-preserving snapshot and reads it back with cursors intact", async () => {
    seed(48);
    const journal = open();
    const expected = journal.records().map(({ seq, type, payload }) => ({ seq, type, payload }));
    const epoch = journal.currentEpoch();
    const cursor = journal.cursorAt(20);
    const receipt = await journal.compactInBackground({ stagingDir });
    expect(receipt).toMatchObject({ records: 48, retainedCount: 48, retiredCount: 0 });
    expect(snapshotFrameCount(journal.path)).toBeGreaterThanOrEqual(3);
    expect(journal.records().map(({ seq, type, payload }) => ({ seq, type, payload }))).toEqual(
      expected,
    );
    expect(journal.sequenceAfter(cursor)).toBe(20);
    expect(journal.append("tail", null).seq).toBe(49);
    journal.close();
    const reopened = open();
    expect(reopened.records().map(({ seq, type, payload }) => ({ seq, type, payload }))).toEqual([
      ...expected,
      { seq: 49, type: "tail", payload: null },
    ]);
    expect(reopened.records(reopened.sequenceAfter(cursor))).toHaveLength(29);
    expect(reopened.records().every((record) => record.epoch === epoch)).toBe(true);
  });

  it("writes gaps into the chunk chain when the fold retires records and reopens without the fold", async () => {
    seed(48);
    const journal = open({ fold: dropHistory });
    expect(journal.records().map((record) => record.seq)).toEqual([45]);
    const receipt = await journal.compactInBackground({ stagingDir });
    expect(receipt).toMatchObject({ records: 1, retainedCount: 1, retiredCount: 0 });
    expect(journal.currentSequence()).toBe(48);
    journal.close();
    const plain = open();
    expect(plain.records().map((record) => record.seq)).toEqual([45]);
    expect(plain.currentSequence()).toBe(48);
    expect(plain.records()[0]?.type).toBe("latest");
    expect(replayFrames(readFileSync(plain.path), "global").records[0]?.type).toBe("latest");
    expect(readFileSync(plain.path).includes(Buffer.from(COMPACTED_SNAPSHOT))).toBe(true);
  });

  it("never runs synchronous threshold compaction when a fold is configured", () => {
    for (const prepare of [false, true]) {
      const rootDir = join(root, prepare ? "prepared" : "direct");
      const seeded = open({ rootDir });
      seeded.appendBatch(
        Array.from({ length: 40 }, (_, n) => ({
          type: n % 4 === 0 ? "latest" : "history",
          payload: { n, text: "payload ".repeat(32) },
        })),
      );
      const epoch = seeded.currentEpoch();
      seeded.close();
      const before = readFileSync(seeded.path);
      const over = {
        rootDir,
        fold: dropHistory,
        deferCompaction: false,
        compactionThresholdBytes: 1,
      };
      const journal = open(over, prepare);
      if (prepare) journal.activatePrepared();
      expect(readFileSync(journal.path)).toEqual(before);
      expect(journal.currentEpoch()).toBe(epoch);
      expect(journal.currentSequence()).toBe(40);
      expect(journal.records().map((record) => record.seq)).toEqual([37]);
      expect(journal.atCompactionThreshold()).toBe(true);
      expect(journal.append("still.chained", null).seq).toBe(41);
      journal.close();
      const verbatim = open({ rootDir });
      expect(verbatim.currentEpoch()).toBe(epoch);
      expect(verbatim.currentSequence()).toBe(41);
      verbatim.close();
      // Without a fold the library default still compacts synchronously at the threshold.
      const plain = open({ rootDir, deferCompaction: false, compactionThresholdBytes: 1 });
      expect(plain.currentEpoch()).not.toBe(epoch);
      expect(plain.currentSequence()).toBe(41);
      expect(readFileSync(plain.path).length).toBeLessThan(before.length);
    }
  });

  it("refuses explicit synchronous compaction under a fold and leaves the file intact", async () => {
    const seeded = seed(40);
    const before = readFileSync(seeded.path);
    const journal = open({ fold: dropHistory });
    expect(() => journal.compact()).toThrow(/unavailable with a fold; use compactInBackground/);
    expect(readFileSync(journal.path)).toEqual(before);
    expect(journal.currentEpoch()).toBe(seeded.epoch);
    expect(journal.currentSequence()).toBe(40);
    expect(journal.records().map((record) => record.seq)).toEqual([37]);
    expect(journal.state().status).toBe("ready");
    expect(await journal.compactInBackground({ stagingDir })).toMatchObject({ records: 1 });
    expect(journal.currentEpoch()).toBe(seeded.epoch);
    expect(journal.append("after.refusal", null).seq).toBe(41);
  });

  it("reports replay-time retirement separately from compaction-time retirement", async () => {
    seed(40);
    const prepared = open({ fold: dropHistory }, true);
    expect(prepared.retiredAtReplay()).toMatchObject({ count: 39 });
    expect(prepared.retiredAtReplay().bytes).toBeGreaterThan(39 * 256);
    prepared.activatePrepared();
    const replayed = prepared.retiredAtReplay();
    expect(replayed.count).toBe(39);
    prepared.append("unfolded", { n: 1 });
    expect(await prepared.compactInBackground({ stagingDir })).toMatchObject({
      records: 2,
      retainedCount: 2,
      retiredCount: 0,
      retiredBytes: 0,
    });
    expect(prepared.retiredAtReplay()).toEqual(replayed);
    prepared.close();
    const direct = open({ fold: dropHistory });
    expect(direct.retiredAtReplay()).toEqual({ count: 0, bytes: 0 });
    direct.close();
    expect(open().retiredAtReplay()).toEqual({ count: 0, bytes: 0 });
  });

  it("fires the threshold hook once per crossing and re-arms after any completed pass", async () => {
    const crossings: number[] = [];
    const journal = open({
      compactionThresholdBytes: 4096,
      onCompactionThreshold: () => crossings.push(journal.physicalBytes()),
    });
    const payload = { text: "x".repeat(1500) };
    expect(journal.atCompactionThreshold()).toBe(false);
    journal.append("one", payload);
    journal.append("two", payload);
    await Promise.resolve();
    expect(crossings).toEqual([]);
    journal.append("three", payload);
    journal.append("four", payload);
    await Promise.resolve();
    expect(crossings).toHaveLength(1);
    // A typed decline completes the pass and re-arms the hook while the file stays over.
    expect(await journal.compactInBackground({ stagingDir, signal: AbortSignal.abort() })).toEqual({
      declined: true,
      reason: "aborted",
    });
    journal.append("five", payload);
    journal.append("six", payload);
    await Promise.resolve();
    expect(crossings).toHaveLength(2);
    expect(await journal.compactInBackground({ stagingDir })).toMatchObject({ records: 6 });
    expect(journal.atCompactionThreshold()).toBe(false);
    for (let n = 0; n < 4; n += 1) journal.append("again", payload);
    await Promise.resolve();
    expect(crossings).toHaveLength(3);
  });

  it("re-fires only after a threshold of NEW bytes once an install left the file large", async () => {
    const crossings: number[] = [];
    const journal = open({
      compactionThresholdBytes: 4096,
      onCompactionThreshold: () => crossings.push(journal.physicalBytes()),
    });
    // Incompressible retained history well above the threshold, plus one
    // compressible record so the pass still reclaims bytes and installs.
    for (let n = 0; n < 8; n += 1) {
      journal.append("keep", { blob: randomBytes(1024).toString("base64") });
    }
    journal.append("fluff", { text: "x".repeat(16 * 1024) });
    await Promise.resolve();
    expect(crossings).toHaveLength(1);
    expect(await journal.compactInBackground({ stagingDir })).toMatchObject({ records: 9 });
    const installed = journal.physicalBytes();
    expect(installed).toBeGreaterThan(4096); // still over the absolute size
    expect(journal.atCompactionThreshold()).toBe(false);
    // Appends worth less than a threshold of growth stay quiet — the absolute
    // edge re-fired (and re-compacted) on every one of these.
    const small = { text: "y".repeat(1000) };
    journal.append("a", small);
    journal.append("b", small);
    await Promise.resolve();
    expect(journal.physicalBytes() - installed).toBeLessThan(4096);
    expect(crossings).toHaveLength(1);
    journal.append("c", small);
    journal.append("d", small);
    await Promise.resolve();
    expect(journal.physicalBytes() - installed).toBeGreaterThanOrEqual(4096);
    expect(crossings).toHaveLength(2);
  });

  it("reopens an already-compacted partition quiet: the folded replay is a completed pass", async () => {
    const seeded = open({ fold: keepEverything, compactionThresholdBytes: 4096 });
    for (let n = 0; n < 8; n += 1) {
      seeded.append("keep", { blob: randomBytes(1024).toString("base64") });
    }
    seeded.append("fluff", { text: "x".repeat(16 * 1024) });
    expect(await seeded.compactInBackground({ stagingDir })).toMatchObject({ records: 9 });
    const installed = seeded.physicalBytes();
    expect(installed).toBeGreaterThan(4096);
    seeded.close();
    // A restart on the installed file (still over the absolute size) must not
    // rewrite it again to reclaim nothing: the replay retired nothing, so the
    // baseline is the file itself and only a threshold of NEW bytes crosses.
    const crossings: number[] = [];
    const reopened = open({
      fold: keepEverything,
      compactionThresholdBytes: 4096,
      onCompactionThreshold: () => crossings.push(reopened.physicalBytes()),
    });
    expect(reopened.physicalBytes()).toBe(installed);
    expect(reopened.retiredAtReplay()).toEqual({ count: 0, bytes: 0 });
    expect(reopened.atCompactionThreshold()).toBe(false);
    expect(await reopened.compactInBackground({ stagingDir })).toEqual({
      declined: true,
      reason: "below_threshold",
    });
    const small = { text: "y".repeat(1000) };
    reopened.append("a", small);
    reopened.append("b", small);
    await Promise.resolve();
    expect(crossings).toEqual([]);
    reopened.append("c", small);
    reopened.append("d", small);
    await Promise.resolve();
    expect(crossings).toHaveLength(1);
    expect(await reopened.compactInBackground({ stagingDir })).toMatchObject({ records: 13 });
    expect(reopened.atCompactionThreshold()).toBe(false);
  });

  it("fires once at reopen when the folded replay retires a threshold's worth of bytes", async () => {
    seed(48);
    const journal = open({ fold: dropHistory, compactionThresholdBytes: 4096 });
    expect(journal.retiredAtReplay().count).toBe(47);
    expect(journal.retiredAtReplay().bytes).toBeGreaterThanOrEqual(4096);
    expect(journal.atCompactionThreshold()).toBe(true);
    expect(await journal.compactInBackground({ stagingDir })).toMatchObject({
      records: 1,
      retainedCount: 1,
    });
    expect(journal.physicalBytes()).toBeLessThan(4096);
    expect(journal.atCompactionThreshold()).toBe(false);
    expect(await journal.compactInBackground({ stagingDir })).toEqual({
      declined: true,
      reason: "below_threshold",
    });
    journal.close();
    // Without a fold nothing was evaluated at replay: the absolute-size
    // trigger of the standalone inline path is unchanged.
    seed(48);
    expect(open({ compactionThresholdBytes: 4096 }).atCompactionThreshold()).toBe(true);
  });

  it("settles the growth baseline on a failed pass: one failure per crossing, then quiet", async () => {
    const crossings: number[] = [];
    const journal = open({
      compactionThresholdBytes: 4096,
      onCompactionThreshold: () => crossings.push(journal.physicalBytes()),
    });
    const payload = { text: "x".repeat(1500) };
    for (const type of ["one", "two", "three", "four"]) journal.append(type, payload);
    await Promise.resolve();
    expect(crossings).toHaveLength(1);
    // An unwritable staging directory (the ENOSPC shape): the pass folds the
    // prefix, fails to create its candidate, and rejects.
    chmodSync(stagingDir, 0o500);
    try {
      await expect(journal.compactInBackground({ stagingDir })).rejects.toThrow(/EACCES/);
      const failedAt = journal.physicalBytes();
      expect(journal.atCompactionThreshold()).toBe(false);
      // The failure settled the baseline: appends worth less than a threshold
      // stay quiet instead of re-folding and failing on every one of them...
      journal.append("five", payload);
      journal.append("six", payload);
      await Promise.resolve();
      expect(journal.physicalBytes() - failedAt).toBeLessThan(4096);
      expect(crossings).toHaveLength(1);
      // ...and a threshold of NEW bytes costs exactly one more failure.
      journal.append("seven", payload);
      await Promise.resolve();
      expect(journal.physicalBytes() - failedAt).toBeGreaterThanOrEqual(4096);
      expect(crossings).toHaveLength(2);
      await expect(journal.compactInBackground({ stagingDir })).rejects.toThrow(/EACCES/);
      expect(journal.atCompactionThreshold()).toBe(false);
    } finally {
      chmodSync(stagingDir, 0o700);
    }
    // Writable again: the next crossing installs and resets the edge.
    for (const type of ["eight", "nine", "ten"]) journal.append(type, payload);
    await Promise.resolve();
    expect(crossings).toHaveLength(3);
    expect(await journal.compactInBackground({ stagingDir })).toMatchObject({ records: 10 });
    expect(journal.atCompactionThreshold()).toBe(false);
  });

  it("never fires the threshold hook after a synchronous close", async () => {
    const hook = vi.fn();
    const journal = open({ compactionThresholdBytes: 1, onCompactionThreshold: hook });
    journal.append("cross", { n: 1 });
    journal.close();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hook).not.toHaveBeenCalled();
  });
});
