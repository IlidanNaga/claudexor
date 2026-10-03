import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DurableJournal, journalPartitionDirectory } from "./index.js";
import { replayFrames } from "./frame-codec.js";

const sourcePath = process.env.CLAUDEXOR_LIVE_JOURNAL;
const partition = process.env.CLAUDEXOR_LIVE_PARTITION ?? "global";

describe.skipIf(!sourcePath)("large live journal dogfood", () => {
  it("prepares and activates an immutable production-shaped snapshot", () => {
    const source = resolve(sourcePath!);
    const before = readStableFile(source);
    expect(before.bytes.length).toBeGreaterThan(100 * 1024 * 1024);
    const replay = replayFrames(before.bytes, partition);
    expect(replay.error).toBeNull();
    expect(replay.incompleteOffset).toBeNull();
    expect(replay.records.length).toBeGreaterThanOrEqual(200_000);
    const first = replay.records[0];
    const last = replay.records.at(-1);
    expect(first?.seq).toBe(1);
    expect(first?.partition).toBe(partition);
    expect(last?.seq).toBe(replay.records.length);
    expect(last?.partition).toBe(partition);

    const sourceDir = dirname(source);
    expect(existsSync(join(sourceDir, "append.pending.json"))).toBe(false);
    const tempRoot = realpathSync.native(
      mkdtempSync(join(tmpdir(), ".claudexor-journal-live-test-")),
    );
    chmodSync(tempRoot, 0o700);
    try {
      const journalRoot = join(tempRoot, "journal");
      const partitionDir = journalPartitionDirectory(journalRoot, partition);
      mkdirSync(partitionDir, { recursive: true, mode: 0o700 });
      chmodSync(journalRoot, 0o700);
      chmodSync(partitionDir, 0o700);
      const copyPath = join(partitionDir, "journal.bin");
      writeFileSync(copyPath, before.bytes, { mode: 0o600 });

      const prepared = (
        DurableJournal as unknown as {
          prepare(options: {
            rootDir: string;
            partition: string;
            compactionThresholdBytes: number;
          }): DurableJournal;
        }
      ).prepare({
        rootDir: journalRoot,
        partition,
        compactionThresholdBytes: Number.MAX_SAFE_INTEGER,
      });
      try {
        expect(prepared.state().status).toBe("ready");
        expect(prepared.currentSequence()).toBe(last?.seq);
        const preparedTail = prepared.records(prepared.currentSequence() - 1)[0];
        expect(preparedTail?.seq).toBe(last?.seq);
        expect(preparedTail?.partition).toBe(partition);

        prepared.activatePrepared();
        expect(prepared.state().status).toBe("ready");
        expect(prepared.currentSequence()).toBe(last?.seq);
        const activatedTail = prepared.records(prepared.currentSequence() - 1)[0];
        expect(activatedTail?.seq).toBe(last?.seq);
        expect(activatedTail?.partition).toBe(partition);
      } finally {
        prepared.close();
      }
      expect(readStableFile(copyPath).hash).toBe(before.hash);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    expect(readStableFile(source).hash).toBe(before.hash);
  }, 120_000);
});

function readStableFile(path: string): { bytes: Buffer; hash: string } {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) throw new Error("journal is not a private file");
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  if (
    !after.isFile() ||
    after.nlink !== 1n ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs
  ) {
    throw new Error("journal changed during dogfood read");
  }
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}
