import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WorkspaceManager } from "./manager.js";
import { applyWorkspaceFiles, verifyWorkspaceFiles } from "./files-apply.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const hash = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("portable ordinary-folder capture and delivery", () => {
  it("captures full changed binary bytes, survives disposal, and applies with the platform's file modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-directory-portable-"));
    roots.push(root);
    const source = join(root, "source"),
      run = join(root, "run");
    await mkdir(source);
    await writeFile(join(source, "input.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(source, "unselected.txt"), "preserve source");
    const manager = new WorkspaceManager(source, { runtimeRoot: join(root, "runtime") });
    const envelope = await manager.create({
      taskId: "task",
      attemptId: "a",
      workspaceKind: "directory",
      scopePaths: ["input.bin"],
    });
    await expect(access(join(envelope.worktree_path, "unselected.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const output = Buffer.alloc(5 * 1024 * 1024 + 19, 0xa5);
    output[0] = 0;
    await writeFile(join(envelope.worktree_path, "input.bin"), output);
    await writeFile(join(envelope.worktree_path, "new.txt"), "new result");
    const capture = await manager.captureFiles(envelope, run);
    expect(capture.manifestSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    await manager.dispose(envelope);
    const image = capture.manifest.entries.find((entry) => entry.path === "input.bin")?.after;
    expect(image?.kind).toBe("file");
    if (image?.kind !== "file") throw new Error("no file result");
    expect(hash(await readFile(join(run, image.artifactPath!)))).toBe(hash(output));
    await verifyWorkspaceFiles(capture.manifest, run);
    const first = await applyWorkspaceFiles(source, capture.manifest, run, ["new.txt"]);
    expect(first).toMatchObject({ applied: true, appliedPaths: ["new.txt"] });
    expect(await readFile(join(source, "input.bin"))).toEqual(Buffer.from([0, 1, 2]));
    const second = await applyWorkspaceFiles(source, capture.manifest, run, ["input.bin"]);
    expect(second.applied).toBe(true);
    expect(hash(await readFile(join(source, "input.bin")))).toBe(hash(output));
    expect(await readFile(join(source, "unselected.txt"), "utf8")).toBe("preserve source");
    await expect(access(join(source, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("a direct selected output uses file evidence without a copied baseline or Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-direct-portable-"));
    roots.push(root);
    const source = join(root, "source");
    await mkdir(source);
    const manager = new WorkspaceManager(source, { runtimeRoot: join(root, "runtime") });
    const env = await manager.create({
      taskId: "t",
      attemptId: "a",
      workspaceKind: "directory",
      scopePaths: ["output.bin"],
      inPlace: true,
    });
    await writeFile(join(source, "output.bin"), Buffer.from([255, 0, 10]));
    const capture = await manager.captureFiles(env, join(root, "run"));
    expect(capture.manifest).toMatchObject({
      isolation: "live",
      executionRoot: source,
      entries: [{ path: "output.bin", before: null }],
    });
    expect(capture.noChanges).toBe(false);
    await manager.dispose(env);
    expect(await readFile(join(source, "output.bin"))).toEqual(Buffer.from([255, 0, 10]));
    await expect(access(join(source, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
