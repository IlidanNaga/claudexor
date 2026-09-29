import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@claudexor/config";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "@claudexor/control-api";
import type { HarnessAdapter } from "@claudexor/core";
import { credentialProfileUnpinned, runCapture } from "@claudexor/core";
import { PreProgressRefusalLedger, type QuotaRegistry } from "@claudexor/daemon";
import { Orchestrator } from "@claudexor/orchestrator";
import { ConformanceReport, ControlQuotaResponse, HarnessManifest } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { parseArgs } from "./args.js";
import { controlServices } from "./control-services.js";
import { profilesCommandWithDeps } from "./credential-commands.js";
import {
  bustCredentialStatusCaches,
  bustGlobalCredentialStatusCaches,
} from "./credential-status-invalidation.js";
import { preProgressRefusalLedger } from "./run-orchestrator.js";

// #363 consumer regression: the daemon's real pre-progress refusal ledger
// wired into the real Orchestrator, across SEQUENTIAL runs — the path the
// observed incident took (every unpinned run started on the refusing row
// because the no-evidence tie broke by profile id). Offline stub harness only.

const reapDirs: string[] = [];
function reapMk(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  reapDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function initRepo(): Promise<string> {
  const repo = reapMk("claudexor-363-repo-");
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    ...["-c", "user.email=t@t.dev", "-c", "user.name=t"],
    ...["commit", "-m", "init"],
  ]);
  return repo;
}

type Lane = "ask" | "agent";
/** How one account answers a spawn in the current scenario. */
type Behavior = "serve" | "refuse_after_start" | "refuse_before_spawn";
/** What happens while an account's vendor session is in flight (after start). */
type AfterStart = Partial<Record<string, () => Promise<void> | void>>;

function stubAdapter(
  lane: Lane,
  spawns: Array<string | null>,
  behavior: Record<string, Behavior>,
  unpinned: boolean[] = [],
  afterStart: AfterStart = {},
): HarnessAdapter {
  const id = "stub";
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capabilities:
          lane === "ask" ? { plan: true, review: true, read_files: true } : { implement: true },
        access_profiles_supported: [lane === "ask" ? "readonly" : "workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: lane === "ask" ? ["explain", "audit", "plan", "review"] : ["implement"],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: id,
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        detail: "fixture profile verified",
        last_verified_at: new Date().toISOString(),
      };
    },
    async *run(spec) {
      const profileId = spec.credential_profile?.profile_id ?? null;
      spawns.push(profileId);
      unpinned.push(credentialProfileUnpinned(spec));
      const ts = new Date().toISOString();
      const s = spec.session_id;
      const mode = behavior[profileId ?? ""] ?? "serve";
      if (mode === "refuse_before_spawn") {
        // The adapter's own readiness refusal (Cursor: a status probe that
        // could not confirm the login) — the vendor session never started.
        yield { type: "error", session_id: s, ts, error: "login state is unknown" };
        yield { type: "completed", session_id: s, ts };
        return;
      }
      yield { type: "started", session_id: s, ts };
      await afterStart[profileId ?? ""]?.();
      if (mode === "refuse_after_start") {
        // Unclassified vendor prose on purpose: no typed limit, no dictionary.
        yield { type: "error", session_id: s, ts, error: "You're out of usage. Switch to Auto." };
        yield {
          type: "completed",
          session_id: s,
          ts,
          payload: { exit_code: 1, harness_reported_error: true },
        };
        return;
      }
      if (lane === "agent")
        writeFileSync(join(spec.cwd, "CHANGED.txt"), `served by ${profileId}\n`);
      yield { type: "message", session_id: s, ts, text: "4" };
      yield { type: "completed", session_id: s, ts, payload: { exit_code: 0 } };
    },
  };
}

/** Two subscription rows `a`/`b` of the stub harness under the default policy. */
function withTwoAccountPool<T>(fn: () => Promise<T>): Promise<T> {
  const configDir = reapMk("claudexor-363-config-");
  const previous = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  const row = (profileId: string): string[] => [
    `  - profile_id: ${profileId}`,
    "    harness_id: stub",
    `    display_name: ${profileId}`,
    "    credential_kind: config_dir_login",
    `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", `stub-${profileId}`))}`,
  ];
  writeFileSync(
    join(configDir, "config.yaml"),
    [
      "credential_profiles:",
      ...row("a"),
      ...row("b"),
      // The direct CLI login's target (a config-dir login harness).
      "  - profile_id: c",
      "    harness_id: cursor",
      "    display_name: c",
      "    credential_kind: config_dir_login",
      `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "cursor-c"))}`,
      "runtime:",
      "  transient_retry:",
      "    max_retries: 0",
      "",
    ].join("\n"),
  );
  return fn().finally(() => {
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
  });
}

async function run(
  lane: Lane,
  ledger: PreProgressRefusalLedger,
  behavior: Record<string, Behavior>,
  pin?: string,
  afterStart?: AfterStart,
) {
  const repo = await initRepo();
  const spawns: Array<string | null> = [];
  const unpinned: boolean[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const res = await new Orchestrator({
    registry: new Map([["stub", stubAdapter(lane, spawns, behavior, unpinned, afterStart)]]),
    reviewers: [],
    preProgressRefusals: ledger,
  }).run({
    repoRoot: repo,
    prompt: lane === "ask" ? "2+2?" : "do it",
    mode: lane,
    harnesses: ["stub"],
    ...(lane === "agent" ? { n: 1 } : {}),
    ...(pin ? { credentialProfileId: pin } : {}),
    onEvent: (event) =>
      events.push({ type: event.type, payload: event.payload as Record<string, unknown> }),
  });
  const selected = events
    .filter((e) => e.type === "route.account.pool_selected")
    .map((e) => e.payload["profile_id"]);
  return {
    spawns,
    unpinned,
    selected,
    lifecycle: res.lifecycle,
    types: events.map((e) => e.type),
  };
}

const marks = (ledger: PreProgressRefusalLedger) =>
  ledger.live().map((o) => [o.harness_id, o.profile_id, o.requested_model]);

// The daemon's real invalidation owner (control-API profile mutations and the
// login/logout lifecycle) clears the daemon's own ledger singleton.
const noQuota = () => ({ noteCredentialChange() {} }) as unknown as QuotaRegistry;
const mutateAccountA = () =>
  bustCredentialStatusCaches(noQuota, { harnessId: "stub", profileId: "a" });

/** `claudexor profiles login cursor c` whose vendor login FAILED — it may still
 * have rewritten a credential — reporting through the real control route to
 * the real daemon services on an ephemeral loopback port (#363). The CLI never
 * clears anything in its own process. */
async function cliProfileLogin(): Promise<void> {
  const configDir = process.env.CLAUDEXOR_CONFIG_DIR as string;
  const bin = join(configDir, "cursor-agent");
  writeFileSync(bin, "#!/bin/sh\nexit 1\n");
  chmodSync(bin, 0o755);
  const previousBin = process.env.CLAUDEXOR_CURSOR_BIN;
  process.env.CLAUDEXOR_CURSOR_BIN = bin;
  const emptyQuota = ControlQuotaResponse.parse({
    snapshots: [],
    absences: [],
    refreshed_at: null,
  });
  const services = controlServices(
    undefined as never,
    undefined as never,
    undefined as never,
    { invalidateCredentialProfile: () => ({}), listThreads: () => [] } as never,
    { current: () => ({ list: () => [] }) } as never,
    undefined as never,
    { invalidate() {} } as never,
    undefined as never,
    (() => ({ noteCredentialChange() {}, read: () => emptyQuota })) as never,
    async () => [],
  );
  const token = "pre-progress-cli-login";
  const server = new DaemonControlApiServer({
    token,
    daemon: {
      enqueue: async () => ({ id: "unused", state: "queued" }),
      status: async (id: string) => ({ id, state: "failed" }),
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
    } as never,
    services: services as NonNullable<DaemonControlApiOptions["services"]>,
  });
  const { host, port } = await server.start();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const profile = loadConfig(noProjectRepoRoot()).global.credential_profiles.find(
      (entry) => entry.harness_id === "cursor",
    );
    const status = {
      profile_id: "c",
      harness_id: "cursor",
      availability: "unknown",
      verification: "not_run",
    };
    await profilesCommandWithDeps(parseArgs(["profiles", "login", "cursor", "c"]), false, {
      daemonGet: async () => ({ profiles: [{ profile, status, identity: null }] }),
      spawnSync: (() => ({
        pid: 0,
        output: [],
        stdout: "",
        stderr: "",
        status: 1,
        signal: null,
      })) as never,
      ensureDaemon: async () => ({ addr: { baseUrl: `http://${host}:${port}`, token } }),
    });
  } finally {
    log.mockRestore();
    await server.stop();
    if (previousBin === undefined) delete process.env.CLAUDEXOR_CURSOR_BIN;
    else process.env.CLAUDEXOR_CURSOR_BIN = previousBin;
  }
}

for (const lane of ["ask", "agent"] as const) {
  describe(`pre-progress refusal carries across unpinned runs (${lane} lane, #363)`, () => {
    it("demotes the refusing account on the next unpinned run; a served try clears it", async () => {
      await withTwoAccountPool(async () => {
        const ledger = new PreProgressRefusalLedger();
        const aRefuses = { a: "refuse_after_start", b: "serve" } as const;
        // Run 1: the no-evidence tie picks `a`; it refuses right after the
        // session starts, the structural rotation serves the run on `b`.
        const first = await run(lane, ledger, aRefuses);
        expect(first.spawns).toEqual(["a", "b"]);
        expect(first.lifecycle).toBe("succeeded");
        expect(first.types).toContain("route.profile.rotated");
        expect(marks(ledger)).toEqual([["stub", "a", null]]);
        // Run 2: the refusing account is ranked after its sibling — no
        // second refusal, no rotation, whatever the vendor's wording was.
        const second = await run(lane, ledger, aRefuses);
        expect(second.selected).toEqual(["b"]);
        expect(second.spawns).toEqual(["b"]);
        expect(second.lifecycle).toBe("succeeded");
        expect(second.types).not.toContain("route.profile.rotated");
        // Run 3: an explicit pin is untouched by the mark and, once `a`
        // serves again, its success clears the mark.
        const pinned = await run(lane, ledger, { a: "serve", b: "serve" }, "a");
        expect(pinned.spawns).toEqual(["a"]);
        expect(pinned.lifecycle).toBe("succeeded");
        expect(marks(ledger)).toEqual([]);
        // Run 4: back to the ordinary deterministic order.
        const fourth = await run(lane, ledger, { a: "serve", b: "serve" });
        expect(fourth.spawns).toEqual(["a"]);
      });
    });

    it("stays quiet on the ordinary path and for failures that are not the account refusing", async () => {
      await withTwoAccountPool(async () => {
        const ledger = new PreProgressRefusalLedger();
        // Ordinary success records nothing.
        expect((await run(lane, ledger, { a: "serve" })).spawns).toEqual(["a"]);
        expect(marks(ledger)).toEqual([]);
        // The adapter's own pre-spawn refusal never started a vendor session:
        // whatever the run does with it, the account is not demoted.
        await run(lane, ledger, { a: "refuse_before_spawn", b: "serve" });
        expect(marks(ledger)).toEqual([]);
        // A pinned account's refusal fails as-is and demotes nothing.
        const pinned = await run(lane, ledger, { a: "refuse_after_start" }, "a");
        expect(pinned.spawns).toEqual(["a"]);
        expect(pinned.lifecycle).toBe("failed");
        expect(marks(ledger)).toEqual([]);
        expect((await run(lane, ledger, { a: "serve" })).spawns).toEqual(["a"]);
      });
    });

    it.each([
      ["a profile mutation", mutateAccountA],
      ["a login or logout", () => bustGlobalCredentialStatusCaches(noQuota)],
      ["a direct CLI profile login", cliProfileLogin],
    ])(
      "a refusal that ends after %s does not recreate the mark it voided",
      async (_label, mutate) => {
        await withTwoAccountPool(async () => {
          const ledger = preProgressRefusalLedger;
          ledger.noteCredentialChange();
          // `a`'s credential changes while its session is in flight, then the
          // old session is refused before progress.
          const refusing = { a: "refuse_after_start", b: "serve" } as const;
          const first = await run(lane, ledger, refusing, undefined, { a: mutate });
          expect(first.spawns).toEqual(["a", "b"]);
          expect(first.lifecycle).toBe("succeeded");
          expect(marks(ledger)).toEqual([]);
          // The changed credential is not demoted by the old one's refusal.
          expect((await run(lane, ledger, { a: "serve", b: "serve" })).spawns).toEqual(["a"]);
        });
      },
    );

    it.each([
      ["a profile mutation", mutateAccountA],
      ["a direct CLI profile login", cliProfileLogin],
    ])(
      "a served try that ends after %s cannot clear the changed credential's mark",
      async (_label, mutate) => {
        await withTwoAccountPool(async () => {
          const ledger = preProgressRefusalLedger;
          ledger.noteCredentialChange();
          let inFlight!: () => void;
          const reachedStart = new Promise<void>((resolve) => (inFlight = resolve));
          let release!: () => void;
          const held = new Promise<void>((resolve) => (release = resolve));
          // Run 1 starts on `a` and is held in flight on the old credential.
          const first = run(lane, ledger, { a: "serve" }, undefined, {
            a: async () => {
              inFlight();
              await held;
            },
          });
          await reachedStart;
          await mutate();
          // Run 2 starts on the changed credential and is refused before progress.
          const second = await run(lane, ledger, { a: "refuse_after_start", b: "serve" });
          expect(second.spawns).toEqual(["a", "b"]);
          expect(marks(ledger)).toEqual([["stub", "a", null]]);
          // Run 1's old-credential success says nothing about the new credential.
          release();
          const firstResult = await first;
          expect(firstResult.spawns).toEqual(["a"]);
          expect(firstResult.lifecycle).toBe("succeeded");
          expect(marks(ledger)).toEqual([["stub", "a", null]]);
        });
      },
    );

    it("every spawn, rotated or not, carries the engine's pin fact to the adapter", async () => {
      await withTwoAccountPool(async () => {
        const ledger = new PreProgressRefusalLedger();
        // The pool's pick and the rotation target are unpinned choices: an
        // adapter may start either on a bounded last positive status answer.
        const rotated = await run(lane, ledger, { a: "refuse_after_start", b: "serve" });
        expect(rotated.spawns).toEqual(["a", "b"]);
        expect(rotated.unpinned).toEqual([true, true]);
        // The same account named by the run is a pin: never admitted on it.
        const pinned = await run(lane, ledger, { a: "serve" }, "a");
        expect(pinned.spawns).toEqual(["a"]);
        expect(pinned.unpinned).toEqual([false]);
      });
    });
  });
}
