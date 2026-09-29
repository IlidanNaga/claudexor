import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "@claudexor/control-api";
import { createCursorAdapter } from "@claudexor/harness-cursor";
import { ControlQuotaResponse, type CredentialProfile } from "@claudexor/schema";
import { parseArgs } from "./args.js";
import { controlServices } from "./control-services.js";
import { profilesCommandWithDeps } from "./credential-commands.js";
import { modelSubstitutionLedger } from "./model-services.js";
import { registerConfigDirProfile } from "./profile-registration.js";
import { credentialUnusableLedger, preProgressRefusalLedger } from "./run-orchestrator.js";

// #363 consumer regression: `claudexor profiles login` runs the vendor login in
// the CLI process, while every observation that login can outdate (reused
// Cursor status answers, ledger marks, the generations in-flight tries bind)
// lives in the daemon. The REAL command reports through the REAL control route
// to the REAL daemon services on an ephemeral loopback port; the Cursor status
// coordinator probes a synthetic `cursor-agent`. Offline: no vendor, no
// account, no installed daemon.

// The Cursor status probe binds its binary once, at module load.
const vendor = vi.hoisted(() => {
  const dir = `${(process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")}/claudexor-363-login-${process.pid}`;
  process.env.CLAUDEXOR_CURSOR_BIN = `${dir}/cursor-agent`;
  return { dir, bin: `${dir}/cursor-agent` };
});

/** The synthetic store answers `status` with the state it held when the probe
 * STARTED (a probe describes the store before any later change). */
function writeVendor(): void {
  mkdirSync(vendor.dir, { recursive: true });
  writeFileSync(
    vendor.bin,
    [
      "#!/bin/sh",
      `read -r state < "${vendor.dir}/state"`,
      `read -r delay < "${vendor.dir}/delay"`,
      `echo "$*" >> "${vendor.dir}/calls"`,
      '[ "$delay" = 0 ] || /bin/sleep "$delay"',
      'if [ "$state" = out ]; then echo \'{"authenticated":false}\';',
      'else printf \'{"authenticated":true,"email":"%s"}\\n\' "$state"; fi',
      "",
    ].join("\n"),
  );
  chmodSync(vendor.bin, 0o755);
}
const setStore = (state: string, delaySeconds = 0) => {
  writeFileSync(join(vendor.dir, "state"), `${state}\n`);
  writeFileSync(join(vendor.dir, "delay"), `${delaySeconds}\n`);
};
const statusCalls = (): number => {
  try {
    return readFileSync(join(vendor.dir, "calls"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 250 && !predicate(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(predicate()).toBe(true);
}

/** The daemon side: the real control services behind the real HTTP route. */
async function withDaemon<T>(
  fn: (daemon: {
    ensureDaemon: () => Promise<{ addr: { baseUrl: string; token: string } }>;
    authReadiness: { invalidate: ReturnType<typeof vi.fn> };
    quota: { noteCredentialChange: ReturnType<typeof vi.fn> };
  }) => Promise<T>,
): Promise<T> {
  const authReadiness = { invalidate: vi.fn() };
  const emptyQuota = ControlQuotaResponse.parse({
    snapshots: [],
    absences: [],
    refreshed_at: null,
  });
  const quota = { noteCredentialChange: vi.fn(), read: () => emptyQuota, removeSubject: () => 0 };
  const services = controlServices(
    undefined as never,
    undefined as never,
    undefined as never,
    { invalidateCredentialProfile: () => ({}), listThreads: () => [] } as never,
    { current: () => ({ list: () => [] }) } as never,
    undefined as never,
    authReadiness as never,
    undefined as never,
    (() => quota) as never,
    async () => [],
  );
  const token = "cli-login-invalidation-fixture";
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
  try {
    return await fn({
      ensureDaemon: async () => ({ addr: { baseUrl: `http://${host}:${port}`, token } }),
      authReadiness,
      quota,
    });
  } finally {
    await server.stop();
  }
}

type VendorOutcome = { status: number | null; signal: NodeJS.Signals | null; error?: Error };

/** `claudexor profiles login cursor <id>` whose vendor login ends as given,
 * after rewriting the synthetic store to `nextState`. */
async function cliLogin(
  profile: CredentialProfile,
  ensureDaemon: () => Promise<{ addr: { baseUrl: string; token: string } }>,
  outcome: VendorOutcome,
  nextState: string,
): Promise<{ code: number; order: string[] }> {
  const order: string[] = [];
  const row = {
    profile,
    status: {
      profile_id: profile.profile_id,
      harness_id: "cursor",
      availability: "unknown",
      verification: "not_run",
    },
    identity: null,
  };
  const code = await profilesCommandWithDeps(
    parseArgs(["profiles", "login", "cursor", profile.profile_id]),
    false,
    {
      daemonGet: async () => {
        order.push("get");
        return { profiles: [row], harnessAccounts: [], accountPools: [] };
      },
      spawnSync: ((binary: string, args: string[]) => {
        order.push(`spawn ${binary.split("/").pop()} ${args.join(" ")}`);
        setStore(nextState);
        return { pid: 0, output: [], stdout: "", stderr: "", ...outcome };
      }) as never,
      ensureDaemon: async () => {
        order.push("daemon");
        return ensureDaemon();
      },
    },
  );
  return { code, order };
}

const OUTCOMES: Array<[string, VendorOutcome]> = [
  ["a completed login", { status: 0, signal: null }],
  ["a failed login", { status: 1, signal: null }],
  ["an interrupted login", { status: null, signal: "SIGINT" }],
];

describe("direct CLI profile login → daemon-owned credential invalidation (#363)", () => {
  let profile: CredentialProfile;
  let prevConfig: string | undefined;
  let configDir: string;

  beforeAll(() => writeVendor());
  afterAll(() => rmSync(vendor.dir, { recursive: true, force: true }));
  beforeEach(() => {
    prevConfig = process.env.CLAUDEXOR_CONFIG_DIR;
    configDir = join(vendor.dir, `config-${Math.random().toString(36).slice(2)}`);
    mkdirSync(configDir, { recursive: true });
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    rmSync(join(vendor.dir, "calls"), { force: true });
    setStore("old@example.com");
    profile = registerConfigDirProfile({ harnessId: "cursor", profileId: "a" }).profile;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prevConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prevConfig;
    vi.restoreAllMocks();
  });

  it.each(OUTCOMES)(
    "%s voids the daemon's evidence and generations before the verification re-read",
    async (_label, outcome) => {
      await withDaemon(async ({ ensureDaemon, authReadiness, quota }) => {
        const refusal = { harness_id: "cursor", profile_id: "a", requested_model: "m" };
        const sibling = { harness_id: "claude", profile_id: "work", requested_model: "m" };
        preProgressRefusalLedger.noteCredentialChange();
        preProgressRefusalLedger.record(refusal);
        preProgressRefusalLedger.record(sibling);
        const boundA = preProgressRefusalLedger.generation("cursor", "a");
        const boundSibling = preProgressRefusalLedger.generation("claude", "work");
        credentialUnusableLedger.record({
          harness_id: "cursor",
          profile_id: "a",
          model: null,
          code: "auth_revoked",
          source: "attempt_stream",
          detail: null,
          observed_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
        modelSubstitutionLedger.record({
          harness_id: "cursor",
          profile_id: "a",
          requested_model: "m",
        });

        const { order } = await cliLogin(profile, ensureDaemon, outcome, "new@example.com");

        // The report reaches the daemon after the vendor exits and BEFORE the
        // status re-read, whatever the exit.
        expect(order).toEqual(["get", "spawn cursor-agent login", "daemon", "get"]);
        // A native login may rewrite an OS-user-scoped store: like a setup-job
        // login, it voids every account's verdicts and moves every generation.
        expect(preProgressRefusalLedger.live()).toEqual([]);
        expect(preProgressRefusalLedger.generation("cursor", "a")).toBeGreaterThan(boundA);
        expect(preProgressRefusalLedger.generation("claude", "work")).toBeGreaterThan(boundSibling);
        expect(credentialUnusableLedger.live()).toEqual([]);
        expect(modelSubstitutionLedger.live()).toEqual([]);
        expect(authReadiness.invalidate).toHaveBeenCalledWith("cursor");
        expect(quota.noteCredentialChange).toHaveBeenCalled();
      });
    },
  );

  it("a positive status answer from before the login is never reused after it", async () => {
    await withDaemon(async ({ ensureDaemon }) => {
      const cursor = createCursorAdapter();
      const before = await cursor.probeCredentialProfile!(profile);
      expect(before).toMatchObject({ availability: "available", verification: "passed" });
      // The reuse window is live: a second ask does not spawn the vendor.
      await cursor.probeCredentialProfile!(profile);
      expect(statusCalls()).toBe(1);
      // An unsuccessful login still rewrote the store (here: signed it out).
      const { code } = await cliLogin(profile, ensureDaemon, { status: 1, signal: null }, "out");
      expect(code).toBe(1);
      const after = await cursor.probeCredentialProfile!(profile);
      expect(statusCalls()).toBe(2);
      expect(after).toMatchObject({ availability: "unavailable", verification: "not_run" });
    });
  });

  it("a status probe in flight across the login cannot restore its old answer", async () => {
    await withDaemon(async ({ ensureDaemon }) => {
      const cursor = createCursorAdapter();
      // The probe starts on the old credential and is still running when the
      // login ends and the daemon invalidates.
      setStore("old@example.com", 1);
      const inFlight = cursor.probeCredentialProfile!(profile);
      await until(() => statusCalls() === 1);
      await cliLogin(profile, ensureDaemon, { status: 0, signal: null }, "out");
      const stale = await inFlight;
      expect(stale.verification).not.toBe("passed");
      expect(stale.availability).toBe("unknown");
      // Its answer seeded nothing: the next ask spawns and reads the new store.
      const after = await cursor.probeCredentialProfile!(profile);
      expect(statusCalls()).toBe(2);
      expect(after).toMatchObject({ availability: "unavailable" });
    });
  });
});
