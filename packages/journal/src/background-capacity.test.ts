import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurableJournal } from "./index.js";

// Scale only the frame payload cap: the compressed-output and envelope guards
// are the sole live source of typed `capacity` declines.
const CAP = 8192;
vi.mock("./frame-codec.js", async (original) => ({
  ...(await original<typeof import("./frame-codec.js")>()),
  MAX_PAYLOAD_BYTES: 8192,
}));

let root: string;
let stagingDir: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "journal-capacity-")));
  stagingDir = join(root, "staging");
  mkdirSync(stagingDir);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(payload: (n: number) => unknown): DurableJournal {
  const journal = new DurableJournal({
    rootDir: join(root, "journal"),
    partition: "global",
    deferCompaction: true,
    compactionThresholdBytes: 0,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  journal.appendBatch(Array.from({ length: 24 }, (_, n) => ({ type: "row", payload: payload(n) })));
  return journal;
}

describe("background compaction capacity", () => {
  it("declines typed with the cap that fired when a chunk cannot be compressed under it", async () => {
    const journal = fixture((n) => ({ n, blob: randomBytes(768).toString("base64") }));
    try {
      const before = readFileSync(journal.path);
      const logical = journal.records().map(({ seq, payload }) => ({ seq, payload }));
      expect(await journal.compactInBackground({ stagingDir })).toEqual({
        declined: true,
        reason: "capacity",
        cap: CAP,
      });
      expect(readFileSync(journal.path)).toEqual(before);
      expect(journal.state().status).toBe("ready");
      expect(journal.records().map(({ seq, payload }) => ({ seq, payload }))).toEqual(logical);
      expect(journal.append("after.capacity", true).seq).toBe(25);
    } finally {
      journal.close();
    }
  });

  it("moves the growth baseline on a capacity decline so the next attempt waits for new bytes", async () => {
    const crossings: number[] = [];
    const journal = new DurableJournal({
      rootDir: join(root, "journal"),
      partition: "global",
      deferCompaction: true,
      compactionThresholdBytes: 4096,
      now: () => new Date("2026-01-01T00:00:00Z"),
      onCompactionThreshold: () => crossings.push(journal.physicalBytes()),
    });
    const row = () => ({ blob: randomBytes(768).toString("base64") });
    try {
      journal.appendBatch(Array.from({ length: 24 }, () => ({ type: "row", payload: row() })));
      await Promise.resolve();
      expect(crossings).toHaveLength(1);
      expect(await journal.compactInBackground({ stagingDir })).toMatchObject({
        declined: true,
        reason: "capacity",
      });
      // The decline observed the file at this size: the hook is re-armed but a
      // crossing now needs a threshold of NEW bytes, not the same large file.
      const observed = journal.physicalBytes();
      expect(journal.atCompactionThreshold()).toBe(false);
      journal.append("more", row());
      await Promise.resolve();
      expect(journal.physicalBytes() - observed).toBeLessThan(4096);
      expect(crossings).toHaveLength(1);
      for (let n = 0; n < 4; n += 1) journal.append("more", row());
      await Promise.resolve();
      expect(journal.physicalBytes() - observed).toBeGreaterThanOrEqual(4096);
      expect(crossings).toHaveLength(2);
    } finally {
      journal.close();
    }
  });

  it("compacts the same shape when it compresses under the cap", async () => {
    const journal = fixture((n) => ({ n, blob: "x".repeat(1024) }));
    try {
      expect(await journal.compactInBackground({ stagingDir })).toMatchObject({
        records: 24,
        retainedCount: 24,
      });
      expect(journal.append("after.compaction", true).seq).toBe(25);
    } finally {
      journal.close();
    }
  });
});
