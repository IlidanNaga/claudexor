import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectPartitions, ProjectStore } from "@claudexor/daemon";
import { ArtifactStore } from "@claudexor/artifact-store";
import { createRetentionRunner, scheduleStartupRetention } from "./retention-service.js";

const roots: string[] = [];
let previousConfigDir: string | undefined;
let previousHome: string | undefined;

beforeEach(() => {
  // Run trees live in the per-project RUNTIME dir under the user config dir,
  // not inside the repo — scope it so fixtures never touch the real one.
  previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
  previousHome = process.env.HOME;
  const configDir = mkdtempSync(join(tmpdir(), "claudexor-retention-cfg-"));
  roots.push(configDir);
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  // keep_last_runs_per_project defaults to 20 — a single aged run would be
  // spared as "recent". These tests are about the health/serialization gates,
  // so the keep-N sparing (covered in retention.test.ts) is set aside.
  writeFileSync(join(configDir, "config.yaml"), "retention:\n  keep_last_runs_per_project: 0\n");
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project root whose runtime dir holds one long-terminal run tree. */
function projectWithAgedRun(runId: string): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-retention-svc-"));
  roots.push(root);
  const runDir = join(new ArtifactStore(root).runsDir(), runId);
  mkdirSync(join(runDir, "final"), { recursive: true });
  writeFileSync(join(runDir, "final", "summary.md"), "# done\n");
  return root;
}

type FakeThread = {
  id: string;
  run_ids: string[];
  state?: string;
  purge_after?: string | null;
  head_run_id?: string | null;
  repo?: { root: string } | null;
};

function deps(input: {
  projectRoots: string[];
  healthyRoots: string[];
  threadRunIds?: string[];
  threads?: FakeThread[];
  records: Array<{ runId?: string; state: string; finishedAt?: string; params?: unknown }>;
  purged?: string[];
  failPurge?: string;
}) {
  const projects = {
    list: () => input.projectRoots.map((root, i) => ({ id: `p${i}`, root })),
  } as unknown as ProjectStore;
  let rows: FakeThread[] =
    input.threads ?? (input.threadRunIds ? [{ id: "t1", run_ids: input.threadRunIds }] : []);
  const threads = {
    healthyProjectRoots: () => input.healthyRoots,
    // Like the store, a purged thread drops out of every listing.
    listThreads: () => rows.filter((thread) => thread.state !== "purged"),
    turnsFor: () => [],
  } as unknown as ProjectPartitions;
  return {
    projects: () => projects,
    threads,
    daemonJobs: async () => input.records,
    purgeThread: async (id: string) => {
      if (id === input.failPurge) throw new Error("worktree removal failed");
      input.purged?.push(id);
      rows = rows.map((thread) => (thread.id === id ? { ...thread, state: "purged" } : thread));
      return { id, state: "purged" };
    },
  };
}

const ancient = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();

describe("retention service composition", () => {
  it("selects generation ownership from the real default and override roots", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-retention-home-"));
    roots.push(home);
    process.env.HOME = home;
    delete process.env.CLAUDEXOR_CONFIG_DIR;
    const defaultRoot = join(home, ".claudexor");
    for (const name of ["v1", "v2", "v3"]) mkdirSync(join(defaultRoot, name), { recursive: true });
    writeFileSync(
      join(defaultRoot, "v3", "config.yaml"),
      "retention:\n  keep_last_runs_per_project: 0\n",
    );

    const defaultReceipt = await createRetentionRunner(
      deps({ projectRoots: [], healthyRoots: [], records: [] }),
    )({ dry_run: true, data_root_report: true });
    expect(defaultReceipt.data_root_unrecognized).toEqual(["v1"]);

    const overrideRoot = mkdtempSync(join(tmpdir(), "claudexor-retention-override-"));
    roots.push(overrideRoot);
    process.env.CLAUDEXOR_CONFIG_DIR = overrideRoot;
    for (const name of ["v1", "v2", "v3"]) {
      mkdirSync(join(overrideRoot, name), { recursive: true });
    }
    writeFileSync(
      join(overrideRoot, "config.yaml"),
      "retention:\n  keep_last_runs_per_project: 0\n",
    );

    const overrideReceipt = await createRetentionRunner(
      deps({ projectRoots: [], healthyRoots: [], records: [] }),
    )({ dry_run: true, data_root_report: true });
    expect(overrideReceipt.data_root_unrecognized).toEqual(["v1", "v2", "v3"]);
  });

  it("fails CLOSED for a project whose partition journal is quarantined (W3.6)", async () => {
    // The reference set (listThreads/turnsFor) only spans READY partitions. If
    // a quarantined project's runs were still swept, they would be judged
    // against an EMPTY reference set and a live thread's history would vanish.
    const root = projectWithAgedRun("run-quarantined");
    const run = await createRetentionRunner(
      deps({
        projectRoots: [root],
        healthyRoots: [], // partition not ready
        records: [{ runId: "run-quarantined", state: "succeeded", finishedAt: ancient }],
      }),
    )({ dry_run: true });
    // Not examined at all — the project is skipped, its runs protected.
    expect(run.deleted_runs).toEqual([]);
    expect(run.examined_runs).toBe(0);
  });

  it("sweeps a project once its partition is healthy", async () => {
    const root = projectWithAgedRun("run-healthy");
    const run = await createRetentionRunner(
      deps({
        projectRoots: [root],
        healthyRoots: [root],
        records: [{ runId: "run-healthy", state: "succeeded", finishedAt: ancient }],
      }),
    )({ dry_run: true });
    expect(run.examined_runs).toBe(1);
    expect(run.deleted_runs.map((d) => d.run_id)).toEqual(["run-healthy"]);
  });

  it("serializes concurrent passes — two never run at once", async () => {
    // Pinned on the property itself, not on its side effects: the tombstone
    // guard makes overlapping passes idempotent on DISK regardless, so a
    // deletion-count assertion would pass with no serialization at all. This
    // observes concurrency directly through a dep the pass must call.
    const root = projectWithAgedRun("run-serial");
    let active = 0;
    let peak = 0;
    const base = deps({
      projectRoots: [root],
      healthyRoots: [root],
      records: [{ runId: "run-serial", state: "succeeded", finishedAt: ancient }],
    });
    const runner = createRetentionRunner({
      ...base,
      daemonJobs: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        try {
          return await base.daemonJobs();
        } finally {
          active -= 1;
        }
      },
    });
    // The startup pass and an operator `gc` firing together.
    await Promise.all([runner({ dry_run: true }), runner({ dry_run: true })]);
    expect(peak).toBe(1);
  });
});

describe("expired trash purge in the retention pass (owner decision E2)", () => {
  const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const trashThreads: FakeThread[] = [
    { id: "t-expired", run_ids: ["run-trash-only"], state: "trashed", purge_after: past },
    { id: "t-fresh", run_ids: ["run-fresh"], state: "trashed", purge_after: future },
    { id: "t-active", run_ids: [], state: "active", purge_after: null },
  ];

  it("purges ONLY expired trash through the one purge owner and discloses it on opt-in", async () => {
    const purged: string[] = [];
    const runner = createRetentionRunner(
      deps({ projectRoots: [], healthyRoots: [], threads: trashThreads, records: [], purged }),
    );
    const receipt = await runner({ dry_run: false, trash_purge_report: true });
    expect(purged).toEqual(["t-expired"]);
    expect(receipt.purged_threads).toEqual(["t-expired"]);
    expect(receipt.errors).toEqual([]);
  });

  it("still purges without the opt-in but keeps the receipt key absent (version skew)", async () => {
    const purged: string[] = [];
    const receipt = await createRetentionRunner(
      deps({ projectRoots: [], healthyRoots: [], threads: trashThreads, records: [], purged }),
    )({ dry_run: false });
    expect(purged).toEqual(["t-expired"]);
    expect(receipt).not.toHaveProperty("purged_threads");
  });

  it("dry run lists expired trash, deletes nothing, and previews its runs as unreferenced", async () => {
    const root = projectWithAgedRun("run-trash-only");
    const freshRun = join(new ArtifactStore(root).runsDir(), "run-fresh");
    mkdirSync(join(freshRun, "final"), { recursive: true });
    writeFileSync(join(freshRun, "final", "summary.md"), "# done\n");
    const purged: string[] = [];
    const receipt = await createRetentionRunner(
      deps({
        projectRoots: [root],
        healthyRoots: [root],
        threads: trashThreads,
        records: [
          { runId: "run-trash-only", state: "succeeded", finishedAt: ancient },
          { runId: "run-fresh", state: "succeeded", finishedAt: ancient },
        ],
        purged,
      }),
    )({ dry_run: true, trash_purge_report: true });
    expect(purged).toEqual([]);
    expect(receipt.purged_threads).toEqual(["t-expired"]);
    // The would-be-purged thread no longer protects its run in the preview;
    // the still-restorable trashed thread keeps protecting its own.
    expect(receipt.deleted_runs.map((d) => d.run_id)).toEqual(["run-trash-only"]);
    expect(receipt.kept.referenced).toBe(1);
  });

  it("keeps an expired thread with a live turn for a later pass and says why", async () => {
    const purged: string[] = [];
    const receipt = await createRetentionRunner(
      deps({
        projectRoots: [],
        healthyRoots: [],
        threads: trashThreads,
        records: [{ state: "running", params: { threadId: "t-expired", mode: "ask" } }],
        purged,
      }),
    )({ dry_run: false, trash_purge_report: true });
    expect(purged).toEqual([]);
    expect(receipt.purged_threads).toEqual([]);
    expect(receipt.errors).toEqual([
      "expired trash thread t-expired kept: a turn is still running",
    ]);
  });

  it("discloses a failed purge in errors instead of listing it as purged", async () => {
    const receipt = await createRetentionRunner(
      deps({
        projectRoots: [],
        healthyRoots: [],
        threads: trashThreads,
        records: [],
        failPurge: "t-expired",
      }),
    )({ dry_run: false, trash_purge_report: true });
    expect(receipt.purged_threads).toEqual([]);
    expect(receipt.errors).toEqual(["expired trash thread t-expired: worktree removal failed"]);
  });

  it("the startup pass requests the trash disclosure and logs the purge count", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "claudexor-retention-log-"));
    roots.push(logDir);
    const logPath = join(logDir, "daemon.log");
    const requests: unknown[] = [];
    const runner = createRetentionRunner(
      deps({ projectRoots: [], healthyRoots: [], threads: trashThreads, records: [] }),
    );
    scheduleStartupRetention(
      async (request) => {
        requests.push(request);
        return runner(request);
      },
      { logPath, shuttingDown: () => false, delayMs: 0 },
    );
    const readLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
    for (let i = 0; i < 500 && !readLog().includes("retention:"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(requests).toEqual([{ dry_run: false, trash_purge_report: true }]);
    expect(readLog()).toContain("1 expired trash threads");
  });
});
