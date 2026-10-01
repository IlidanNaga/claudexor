import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { resolveHarnessBinary, runCapture } from "@claudexor/core";

/** The name Claudexor has always spawned; Cursor's installer and its Homebrew
 * cask both still link it. */
const CURSOR_LEGACY_BIN = "cursor-agent";
/** Cursor's primary command name. Generic: other tools install an `agent` too. */
const CURSOR_PRIMARY_BIN = "agent";

/**
 * Which command every Cursor surface spawns (discovery, doctor, status probe,
 * model list, key smoke, run, login). Decided on each call, so an install or a
 * vendor update after the daemon started is seen without a restart.
 *
 * `CLAUDEXOR_CURSOR_BIN` wins verbatim. Otherwise `cursor-agent` keeps exactly
 * its old behavior whenever it resolves on the harness PATH. Only when it does
 * not (an install without the alias, or a link an update left dangling) is
 * `agent` considered, and only when its realpath is the binary inside a Cursor
 * install. It is then returned as that absolute launcher, so the child cannot
 * re-resolve the name to a different `agent` earlier on its own PATH. Nothing
 * is executed to decide. With no match the legacy name is returned, so the
 * existing not-found diagnostics stay as they are.
 */
export function resolveCursorBin(
  env: NodeJS.ProcessEnv = process.env,
  resolve: (bin: string) => string | null = (bin) => resolveHarnessBinary(bin, env),
): string {
  const override = env["CLAUDEXOR_CURSOR_BIN"];
  if (override) return override;
  if (resolve(CURSOR_LEGACY_BIN) !== null) return CURSOR_LEGACY_BIN;
  const agent = resolve(CURSOR_PRIMARY_BIN);
  return agent !== null && isCursorInstallLauncher(agent) ? agent : CURSOR_LEGACY_BIN;
}

/**
 * True when the absolute `launcher` resolves to the binary inside a Cursor
 * install: the vendor installer links `~/.local/bin/agent` (and
 * `cursor-agent`) to `~/.local/share/cursor-agent/versions/<v>/cursor-agent`.
 * Cursor's Windows installer copies instead of linking, and its current
 * packages (2026.09.26-dd393fe) ship only `.cmd`/`.ps1` launchers, which the
 * harness resolver never returns.
 */
function isCursorInstallLauncher(launcher: string): boolean {
  if (!isAbsolute(launcher)) return false;
  let real: string;
  try {
    real = realpathSync(launcher);
  } catch {
    return false;
  }
  const versionsDir = dirname(dirname(real));
  return (
    basename(real) === CURSOR_LEGACY_BIN &&
    basename(versionsDir) === "versions" &&
    basename(dirname(versionsDir)) === CURSOR_LEGACY_BIN
  );
}

/** The resolved Cursor CLI's `--version` line, or null when it cannot spawn. */
export async function detectCursorVersion(abortSignal?: AbortSignal): Promise<string | null> {
  const bin = resolveCursorBin();
  try {
    const r = await runCapture(bin, ["--version"], {
      timeoutMs: 10_000,
      abortSignal,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: 0,
    });
    return r.stdout.trim() || `${bin} (version unknown)`;
  } catch {
    return null;
  }
}
