/**
 * Lifetime of the shared `claude --help` capture.
 *
 * The parse is covered in `effort.test.ts`; what is proven here is who OWNS the
 * one capture the whole process shares. A long-lived `claudexord` outlives every
 * individual run, so a memo that records a cancelled run's kill, or a moment when
 * the binary could not be spawned, keeps serving that non-answer forever — and
 * the effort ladder's fallback is a snapshot from ONE CLI version, so the
 * consequence is not staleness but `xhigh` forwarded to a binary that rejects it.
 *
 * These tests drive the real spawn against a stub `claude` on disk, because the
 * hazard lives in the interaction between the memo and the process, not in either
 * one alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `claude --help` as the OLDER installed CLI renders it — one level short of the
 * recorded snapshot, so "read the binary" and "fell back" are distinguishable.
 */
const HELP_2_1_89 = [
  "  --effort <level>                      Effort level for the current session",
  "                                        (low, medium, high, max)",
  "  --fallback-model <model>              Fallback model",
].join("\n");

const LADDER_2_1_89 = ["low", "medium", "high", "max"];

/** A help text that satisfies the readonly consumer's whole required flag set. */
const HELP_READONLY = [
  "  --tools <tools>                       Allowed tools",
  "  --setting-sources <sources>           Setting sources",
  "  --strict-mcp-config                   Only the given MCP config",
  '  --permission-mode <mode>              Permission mode ("plan", "acceptEdits")',
  "  --disable-slash-commands              Disable slash commands",
  "  --no-chrome                           Disable the browser",
].join("\n");

let dir: string;
let bin: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudexor-help-probe-"));
  bin = join(dir, "claude-stub");
  // A fresh module registry per test: both the memo and `BIN` are module state.
  vi.resetModules();
  vi.stubEnv("CLAUDEXOR_CLAUDE_BIN", bin);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Put a stub `claude` where the adapter will look for it. `delaySeconds` keeps the
 * child alive long enough that a cancellation aimed at the shared capture lands
 * DURING it — otherwise a stub that exits instantly could outrun the kill and the
 * test would prove nothing on some runs.
 */
function installStub(help: string, delaySeconds = 0): void {
  const sleep = delaySeconds > 0 ? `sleep ${delaySeconds}\n` : "";
  writeFileSync(bin, `#!/bin/sh\n${sleep}cat <<'CLAUDE_HELP_EOF'\n${help}\nCLAUDE_HELP_EOF\n`);
  chmodSync(bin, 0o755);
}

describe("the shared --help capture belongs to the process, not to its first caller", () => {
  it("survives the cancellation of the run that happened to ask first", async () => {
    installStub(HELP_2_1_89, 0.5);
    const { CLAUDE_EFFORT_SNAPSHOT, probeClaudeEffortLevels } = await import("./effort-probe.js");

    const cancelled = new AbortController();
    cancelled.abort();
    // The cancelled run gives up its own wait and takes the fallback. That is
    // fine: its run is going away.
    expect(await probeClaudeEffortLevels(cancelled.signal)).toEqual({
      levels: CLAUDE_EFFORT_SNAPSHOT,
      live: false,
    });

    // The regression: that run's signal used to reach the shared spawn, so the
    // memo recorded a killed capture and every later run for the lifetime of the
    // daemon read the snapshot — which on this 2.1.89 stub means advertising and
    // forwarding `xhigh` to a binary that does not accept it.
    expect(await probeClaudeEffortLevels()).toEqual({ levels: LADDER_2_1_89, live: true });
  });

  it("re-probes after a capture that never produced an answer", async () => {
    // No stub on disk yet: the spawn itself fails.
    const { CLAUDE_EFFORT_SNAPSHOT, probeClaudeEffortLevels, probeClaudeHelp } =
      await import("./effort-probe.js");
    expect((await probeClaudeHelp()).ok).toBe(false);
    expect(await probeClaudeEffortLevels()).toEqual({
      levels: CLAUDE_EFFORT_SNAPSHOT,
      live: false,
    });

    // A missing or unspawnable binary is a fact about one moment, not about the
    // installation. Once it is there, the next run must actually look again.
    installStub(HELP_2_1_89);
    expect(await probeClaudeEffortLevels()).toEqual({ levels: LADDER_2_1_89, live: true });
  });

  it("re-probes for the readonly consumer too, which used to cache its own failure", async () => {
    const { probeClaudeReadonlyProfile } = await import("./index.js");
    const missing = await probeClaudeReadonlyProfile();
    expect(missing.supported).toBe(false);

    // The second cache repeated the first one's defect one level up: one failed
    // read and the adapter refused every readonly run for the process lifetime.
    installStub(HELP_READONLY);
    expect(await probeClaudeReadonlyProfile()).toMatchObject({
      supported: true,
      missingFlags: [],
    });
  });

  it("re-reads a binary rewritten at the same path, and keeps serving an unchanged one", async () => {
    // The live defect (2026-09-18): a CLI updated in place kept the OLD ladder
    // for the life of the daemon because the memo was keyed by nothing. The
    // memo is now keyed by the binary's identity (realpath, inode, size,
    // mtime), so the next caller after an update reads the new binary — with
    // NO `vi.resetModules()` between the two probes below.
    installStub(HELP_2_1_89);
    const { probeClaudeEffortLevels } = await import("./effort-probe.js");
    expect(await probeClaudeEffortLevels()).toEqual({ levels: LADDER_2_1_89, live: true });
    // Unchanged bytes: still the memo, still the same answer.
    expect(await probeClaudeEffortLevels()).toEqual({ levels: LADDER_2_1_89, live: true });

    const HELP_NEWER = [
      "  --effort <level>                      Effort level for the current session",
      "                                        (low, medium, high, xhigh, max)",
      "  --fallback-model <model>              Fallback model",
    ].join("\n");
    installStub(HELP_NEWER);
    expect(await probeClaudeEffortLevels()).toEqual({
      levels: ["low", "medium", "high", "xhigh", "max"],
      live: true,
    });
  });
});

/**
 * A run whose env patch carries a PATH executes `claude` on that path (the spawn
 * layer applies the patch verbatim over the normalized PATH), so its ladder must
 * be read from the same bytes — not from whichever managed `claude` the host
 * PATH resolves first.
 */
describe("the --help memo follows a run's PATH patch", () => {
  it("reads the ladder of the binary on the patch PATH and keys it separately", async () => {
    // A bare `claude`, resolved on PATH, as production spawns it.
    vi.stubEnv("CLAUDEXOR_CLAUDE_BIN", "");
    const pathDir = join(dir, "patch-bin");
    mkdirSync(pathDir, { recursive: true });
    const counter = join(dir, "spawns");
    writeFileSync(
      join(pathDir, "claude"),
      `#!/bin/sh\necho spawn >> "${counter}"\n/bin/cat <<'CLAUDE_HELP_EOF'\n${HELP_2_1_89}\nCLAUDE_HELP_EOF\n`,
      { mode: 0o755 },
    );
    const { probeClaudeEffortLevels, claudeRunEffortResolution } =
      await import("./effort-probe.js");
    expect(await probeClaudeEffortLevels(undefined, pathDir)).toEqual({
      levels: LADDER_2_1_89,
      live: true,
    });
    // The run-time resolution threads the spec's PATH through the same seam.
    const resolution = await claudeRunEffortResolution(
      { session_id: "ses", effort_hint: "xhigh", env: { PATH: pathDir } },
      { probeEffortLevels: probeClaudeEffortLevels, detectVersion: async () => null },
    );
    expect(resolution.advertised).toEqual(LADDER_2_1_89);
    expect(resolution.disclosure?.text).toContain("effort=xhigh (not accepted");
    // Same patch PATH again: the memo answers, no second spawn.
    await probeClaudeEffortLevels(undefined, pathDir);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(counter, "utf8").split("spawn").length - 1).toBe(1);
  });
});
