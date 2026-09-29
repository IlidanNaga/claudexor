import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@claudexor/config";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { noProjectRepoRoot } from "@claudexor/util";
import { parseArgs } from "./args.js";
import {
  accountsCommandWithDeps,
  profilesCommand,
  profilesCommandWithDeps,
} from "./credential-commands.js";
import { removeProfileFromRegistry } from "./profile-registration.js";

// `profiles add` is the ONLY subcommand that does not talk to the daemon —
// it writes the durable registry through the locked global-config owner. The
// test drives it against a scoped CLAUDEXOR_CONFIG_DIR (the hermetic root).
describe("claudexor profiles add (INV-135)", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-profiles-add-"));
    prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers a config_dir_login profile through the locked global-config owner", async () => {
    const code = await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    expect(code).toBe(0);
    const config = loadConfig(noProjectRepoRoot()).global.credential_profiles;
    expect(config).toHaveLength(1);
    expect(config[0]).toMatchObject({
      profile_id: "work",
      harness_id: "claude",
      credential_kind: "config_dir_login",
      enabled: true,
    });
    // The locator lives under the confinement root (the scoped config dir).
    expect(config[0]?.isolation_locator).toContain(dir);
    expect(config[0]?.isolation_locator).toContain("claude-work");
  });

  it("appends without clobbering an existing registry entry", async () => {
    await profilesCommand(parseArgs(["profiles", "add", "claude", "a"]), true);
    await profilesCommand(parseArgs(["profiles", "add", "codex", "b"]), true);
    await profilesCommand(parseArgs(["profiles", "add", "cursor", "c"]), true);
    const ids = loadConfig(noProjectRepoRoot()).global.credential_profiles.map(
      (p) => `${p.harness_id}/${p.profile_id}`,
    );
    expect(ids).toEqual(["claude/a", "codex/b", "cursor/c"]);
  });

  it("refuses a duplicate (harness, profile) id loudly, leaving the registry intact", async () => {
    await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    const code = await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    expect(code).not.toBe(0);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(1);
  });

  it("refuses a harness without config-dir profiles and a malformed id", async () => {
    expect(await profilesCommand(parseArgs(["profiles", "add", "opencode", "x"]), true)).not.toBe(
      0,
    );
    expect(
      await profilesCommand(parseArgs(["profiles", "add", "claude", "Bad Id"]), true),
    ).not.toBe(0);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(0);
  });
});

/** A loopback control server whose only service answers a direct login's
 * credential-change report (#363); ephemeral port, never a real daemon. */
async function withLoginReportDaemon<T>(
  report: (input: unknown) => Promise<unknown>,
  fn: (ensureDaemon: () => Promise<{ addr: { baseUrl: string; token: string } }>) => Promise<T>,
): Promise<T> {
  const token = "profile-login-report-fixture";
  const server = new DaemonControlApiServer({
    token,
    daemon: {
      enqueue: async () => ({ id: "unused", state: "queued" }),
      status: async (id: string) => ({ id, state: "failed" }),
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
    } as never,
    services: { reportCredentialProfileChange: report },
  });
  const { host, port } = await server.start();
  try {
    return await fn(async () => ({ addr: { baseUrl: `http://${host}:${port}`, token } }));
  } finally {
    await server.stop();
  }
}

describe("claudexor profiles login machine output", () => {
  afterEach(() => vi.restoreAllMocks());

  const row = (harness: string, id: string) => ({
    profile: {
      profile_id: id,
      harness_id: harness,
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: `/tmp/${harness}-${id}`,
      secret_ref: null,
      enabled: true,
      created_at: null,
    },
    status: {
      profile_id: id,
      harness_id: harness,
      availability: "unknown",
      verification: "not_run",
    },
    identity: null,
  });

  it("refuses an interactive Claude login as one JSON object before vendor output", async () => {
    let stdout = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as never);

    const code = await profilesCommandWithDeps(
      parseArgs(["profiles", "login", "claude", "work", "--json"]),
      true,
      {
        daemonGet: async () => ({
          profiles: [row("claude", "work")],
          harnessAccounts: [],
          accountPools: [],
        }),
      },
    );

    expect(code).toBe(2);
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "invalid_argument",
    });
  });

  it.each([true, false])(
    "returns the typed ambiguous policy before output/spawn (json=%s)",
    async (json) => {
      let stdout = "";
      let stderr = "";
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        stdout += String(chunk);
        return true;
      }) as never);
      vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
        stderr += String(chunk);
        return true;
      }) as never);
      const spawnVendor = vi.fn();
      const listing = {
        profiles: [row("agy", "one"), row("agy", "two")],
        harnessAccounts: [],
        accountPools: [],
      };
      const code = await profilesCommandWithDeps(
        parseArgs(["profiles", "login", "agy", "one", ...(json ? ["--json"] : [])]),
        json,
        { daemonGet: async () => listing, spawnSync: spawnVendor as never, platform: "win32" },
      );

      expect(code).toBe(1);
      expect(spawnVendor).not.toHaveBeenCalled();
      if (json) {
        expect(stderr).toBe("");
        expect(JSON.parse(stdout)).toMatchObject({
          ok: false,
          code: "credential_profile_ambiguous",
          requiredActions: ["disable_extra_profiles"],
          context: {
            harnessId: "agy",
            platform: "win32",
            maxEnabledProfiles: 1,
            enabledProfileCount: 2,
          },
        });
      } else {
        expect(stdout).toBe("");
        expect(stderr).toContain("disable extra profiles before continuing");
      }
    },
  );

  it("prepares an agy profile before the direct vendor login spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-agy-login-"));
    const previous = process.env.CLAUDEXOR_CONFIG_DIR;
    const previousBin = process.env.CLAUDEXOR_AGY_BIN;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    const fakeAgy = join(root, "agy");
    writeFileSync(fakeAgy, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeAgy, 0o755);
    process.env.CLAUDEXOR_AGY_BIN = fakeAgy;
    const locator = join(root, "profiles", "agy-work");
    mkdirSync(locator, { recursive: true, mode: 0o700 });
    const agyRow = row("agy", "work");
    const listing = {
      profiles: [{ ...agyRow, profile: { ...agyRow.profile, isolation_locator: locator } }],
      harnessAccounts: [],
      accountPools: [],
    };
    const order: string[] = [];
    const spawnSync = vi.fn(() => {
      order.push("spawn");
      return { status: 0, signal: null, stdout: "", stderr: "" } as never;
    });
    const prepare = vi.fn((home: string) => {
      expect(home).toBe(realpathSync(locator));
      expect(order).toEqual([]);
      order.push("prepare");
    });
    const report = vi.fn(async (input: unknown) => {
      order.push("report");
      expect(input).toEqual({ harnessId: "agy", profileId: "work" });
      return { profile: listing.profiles[0]!.profile, voided: "all_accounts" };
    });
    let gets = 0;
    try {
      const code = await withLoginReportDaemon(report, (ensureDaemon) =>
        profilesCommandWithDeps(parseArgs(["profiles", "login", "agy", "work"]), false, {
          daemonGet: async () => {
            gets += 1;
            if (gets > 1) order.push("reread");
            return gets === 1
              ? listing
              : {
                  ...listing,
                  profiles: [
                    {
                      ...listing.profiles[0],
                      status: {
                        profile_id: "work",
                        harness_id: "agy",
                        availability: "available",
                        verification: "passed",
                      },
                    },
                  ],
                };
          },
          ensureDaemon,
          spawnSync,
          prepareAgyProfileKeychain: prepare,
        }),
      );
      expect(code).toBe(0);
      expect(order).toEqual(["prepare", "spawn", "report", "reread"]);
      expect(prepare).toHaveBeenCalledOnce();
      expect(spawnSync).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previous;
      if (previousBin === undefined) delete process.env.CLAUDEXOR_AGY_BIN;
      else process.env.CLAUDEXOR_AGY_BIN = previousBin;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails a login whose credential-change report the daemon refused, without a re-read (#363)", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-cursor-login-"));
    const previous = process.env.CLAUDEXOR_CONFIG_DIR;
    const previousBin = process.env.CLAUDEXOR_CURSOR_BIN;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    const fakeCursor = join(root, "cursor-agent");
    writeFileSync(fakeCursor, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCursor, 0o755);
    process.env.CLAUDEXOR_CURSOR_BIN = fakeCursor;
    const locator = join(root, "profiles", "cursor-work");
    mkdirSync(locator, { recursive: true, mode: 0o700 });
    const cursorRow = row("cursor", "work");
    const listing = {
      profiles: [{ ...cursorRow, profile: { ...cursorRow.profile, isolation_locator: locator } }],
      harnessAccounts: [],
      accountPools: [],
    };
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const get = vi.fn(async () => listing);
    try {
      const code = await withLoginReportDaemon(
        async () => {
          throw Object.assign(new Error("credential change not recorded"), { status: 503 });
        },
        (ensureDaemon) =>
          profilesCommandWithDeps(parseArgs(["profiles", "login", "cursor", "work"]), false, {
            daemonGet: get,
            ensureDaemon,
            spawnSync: vi.fn(() => ({ status: 0, signal: null }) as never),
          }),
      );
      expect(code).toBe(1);
      expect(get).toHaveBeenCalledOnce();
      expect(stderr).toContain("did not void its credential observations (503)");
    } finally {
      if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previous;
      if (previousBin === undefined) delete process.env.CLAUDEXOR_CURSOR_BIN;
      else process.env.CLAUDEXOR_CURSOR_BIN = previousBin;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("claudexor accounts snapshot (read-only agent doorway)", () => {
  afterEach(() => vi.restoreAllMocks());

  const snapshot = {
    profiles: [
      {
        profile: {
          profile_id: "work",
          harness_id: "claude",
          display_name: "work",
          credential_kind: "config_dir_login",
          isolation_locator: "/tmp/claudexor-review-profile",
        },
        status: {
          profile_id: "work",
          harness_id: "claude",
          availability: "available",
          verification: "passed",
        },
        identity: null,
      },
    ],
    harnesses: [{ id: "claude", status: "ok" }],
    git: { status: "available", version: null, detail: null, remediation: null },
    quota: { snapshots: [], refreshed_at: null },
    quotaEventCursor: "q-1",
    accountPools: [{ harness_id: "claude", next_up: { kind: "profile", profileId: "work" } }],
  };

  it("prints the daemon-owned snapshot in JSON without probing or mutating", async () => {
    let stdout = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as never);
    const get = vi.fn(async () => snapshot);

    const code = await accountsCommandWithDeps(
      parseArgs(["accounts", "snapshot", "--json"]),
      true,
      { daemonGet: get },
    );

    expect(code).toBe(0);
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith("/credential-profiles?snapshot=true");
    expect(JSON.parse(stdout)).toMatchObject({ quotaEventCursor: "q-1" });
    expect(write).toHaveBeenCalledOnce();
  });

  it("rejects an unknown positional without contacting the daemon", async () => {
    const get = vi.fn(async () => snapshot);
    const code = await accountsCommandWithDeps(parseArgs(["accounts", "other", "--json"]), true, {
      daemonGet: get,
    });
    expect(code).toBe(2);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("removeProfileFromRegistry (INV-135 removal owner)", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-profiles-remove-"));
    prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes exactly the named entry and returns it", async () => {
    await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    await profilesCommand(parseArgs(["profiles", "add", "codex", "work"]), true);
    const removed = removeProfileFromRegistry("claude", "work");
    expect(removed).toMatchObject({ harness_id: "claude", profile_id: "work" });
    const left = loadConfig(noProjectRepoRoot()).global.credential_profiles;
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ harness_id: "codex", profile_id: "work" });
  });

  it("refuses an unknown id with a typed 404, leaving the registry intact", async () => {
    await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    expect(() => removeProfileFromRegistry("claude", "ghost")).toThrow(/no credential profile/);
    try {
      removeProfileFromRegistry("codex", "work");
      expect.unreachable("cross-harness removal must refuse");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(404);
    }
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(1);
  });
});
