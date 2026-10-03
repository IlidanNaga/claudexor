import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SetupTerminalTransportErrorCode } from "@claudexor/schema";

export const CONPTY_HELPER_PROTOCOL = "claudexor-conpty-helper-v1";
export const CONPTY_HELPER_ARCHITECTURE = "x64";

export type TerminalTransportBackend = "expect" | "script" | "windows_conpty";

type TerminalTransportSafeFailure =
  | {
      status: "unavailable";
      backend: TerminalTransportBackend | null;
      errorCode: Extract<SetupTerminalTransportErrorCode, "terminal_transport_unavailable">;
      detail: string;
    }
  | {
      status: "unsupported";
      backend: TerminalTransportBackend;
      errorCode: Extract<SetupTerminalTransportErrorCode, "terminal_transport_unsupported">;
      detail: string;
    }
  | {
      status: "probe_failed";
      backend: TerminalTransportBackend;
      errorCode: Extract<SetupTerminalTransportErrorCode, "terminal_transport_probe_failed">;
      detail: string;
    };

export type TerminalTransportResolution =
  | {
      status: "ready";
      backend: TerminalTransportBackend;
      command: { binary: string; args: string[] };
      /** ConPTY reserves helper stderr for bounded control frames. POSIX
       * wrappers still carry vendor diagnostics there and must be teed. */
      helperControlStderr: boolean;
    }
  /** Closed safe failures: detail never includes helper paths, child argv,
   * environment, helper control numbers, or terminal output. */
  | TerminalTransportSafeFailure;

type ExecutableInspection = "missing" | "regular_executable" | "invalid";
type ConptyProbeResult = "ready" | "unsupported" | "failed";

export interface TerminalTransportResolverOptions {
  platform?: NodeJS.Platform;
  helperPath?: string;
  inspectExecutable?: (path: string) => Promise<ExecutableInspection>;
  probeConpty?: (path: string) => Promise<ConptyProbeResult>;
  expectPath?: string;
  scriptPath?: string;
}

const SAFE_DETAILS = {
  unavailable: "terminal transport helper is unavailable on this host",
  unsupported: "terminal transport is unsupported on this host",
  probe_failed: "terminal transport capability probe failed",
} as const;

/**
 * Resolve and wrap a login command that needs a real terminal on stdin.
 *
 * This is the single host-capability and spawn-spec owner used by setup
 * admission, status projection, and the worker immediately before spawn. A
 * Windows helper is never reported ready from file presence: its bounded
 * `--probe` must create and close an HPCON and return the exact protocol marker.
 */
export async function resolvePtyWrappedCommand(
  childBinary: string,
  childArgs: readonly string[],
  options: TerminalTransportResolverOptions = {},
): Promise<TerminalTransportResolution> {
  const platform = options.platform ?? process.platform;
  const inspect = options.inspectExecutable ?? inspectExecutable;

  if (platform === "win32") {
    const helper = await resolveWindowsHelper(options.helperPath, inspect);
    if (helper.status !== "ready") return helper;
    const probe = await (options.probeConpty ?? probeConptyHelper)(helper.path);
    if (probe === "unsupported") {
      return {
        status: "unsupported",
        backend: "windows_conpty",
        errorCode: "terminal_transport_unsupported",
        detail: SAFE_DETAILS.unsupported,
      };
    }
    if (probe !== "ready") {
      return {
        status: "probe_failed",
        backend: "windows_conpty",
        errorCode: "terminal_transport_probe_failed",
        detail: SAFE_DETAILS.probe_failed,
      };
    }
    return {
      status: "ready",
      backend: "windows_conpty",
      command: { binary: helper.path, args: ["--", childBinary, ...childArgs] },
      helperControlStderr: true,
    };
  }

  const words = [childBinary, ...childArgs];
  const expectPath = options.expectPath ?? "/usr/bin/expect";
  const scriptPath = options.scriptPath ?? "/usr/bin/script";
  const expect = await inspect(expectPath);
  if (expect === "regular_executable") {
    if (!words.some((word) => /[{}\\\n]/.test(word))) {
      const spawnCommand = words.map((word) => `{${word}}`).join(" ");
      return {
        status: "ready",
        backend: "expect",
        command: {
          binary: expectPath,
          // `interact` relays our pipes for the whole login. `wait` is
          // load-bearing: interact returns expect's status, not the vendor's.
          args: [
            "-c",
            `set timeout -1; if {[catch {spawn -noecho ${spawnCommand}}]} { exit 127 }; ` +
              "set pid [exp_pid]; interact; catch {wait} r; " +
              "if {[lsearch -exact $r CHILDKILLED] >= 0} { exit 129 }; " +
              "catch {exec kill -TERM $pid}; exit [lindex $r 3]",
          ],
        },
        helperControlStderr: false,
      };
    }
    // Linux can still carry this exact argv through util-linux script. macOS
    // script requires its own stdin to be a TTY and is not a daemon backend.
    if (platform === "darwin") {
      return {
        status: "unsupported",
        backend: "expect",
        errorCode: "terminal_transport_unsupported",
        detail: SAFE_DETAILS.unsupported,
      };
    }
  }

  if (platform === "linux" && (await inspect(scriptPath)) === "regular_executable") {
    const quoted = words.map((word) => `'${word.replaceAll("'", `'"'"'`)}'`).join(" ");
    return {
      status: "ready",
      backend: "script",
      command: { binary: scriptPath, args: ["-e", "-q", "-c", quoted, "/dev/null"] },
      helperControlStderr: false,
    };
  }

  return {
    status: "unavailable",
    backend: null,
    errorCode: "terminal_transport_unavailable",
    detail: SAFE_DETAILS.unavailable,
  };
}

async function resolveWindowsHelper(
  explicitPath: string | undefined,
  inspect: (path: string) => Promise<ExecutableInspection>,
): Promise<
  | { status: "ready"; path: string }
  | Extract<TerminalTransportResolution, { status: "unavailable" }>
> {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        fileURLToPath(new URL("./native/claudexor-conpty-helper.exe", import.meta.url)),
        fileURLToPath(
          new URL("../../core/dist/native/claudexor-conpty-helper.exe", import.meta.url),
        ),
      ];
  for (const candidate of candidates) {
    const result = await inspect(candidate);
    if (result === "missing") continue;
    if (result === "regular_executable") return { status: "ready", path: candidate };
    // A present non-regular adjacent entry is a fail-closed unavailable
    // backend, never permission to search a less-authoritative fallback.
    break;
  }
  return {
    status: "unavailable",
    backend: "windows_conpty",
    errorCode: "terminal_transport_unavailable",
    detail: SAFE_DETAILS.unavailable,
  };
}

async function inspectExecutable(path: string): Promise<ExecutableInspection> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return "invalid";
    await access(path, constants.X_OK);
    return "regular_executable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
  }
}

async function probeConptyHelper(path: string): Promise<ConptyProbeResult> {
  return await new Promise<ConptyProbeResult>((resolveProbe) => {
    const cap = 4_096;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (result: ConptyProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveProbe(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(path, ["--probe"], {
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      settle("failed");
      return;
    }
    const overflow = () => {
      try {
        child.kill();
      } catch {
        /* best effort */
      }
      settle("failed");
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > cap) return overflow();
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > cap) return overflow();
      stderr.push(Buffer.from(chunk));
    });
    child.once("error", () => settle("failed"));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code === 3 && signal === null && isExactUnsupportedProbeFrame(stdoutBytes, stderr)) {
        return settle("unsupported");
      }
      const marker = Buffer.concat(stdout);
      settle(
        code === 0 &&
          signal === null &&
          stderrBytes === 0 &&
          marker.equals(
            Buffer.from(`${CONPTY_HELPER_PROTOCOL}\t${CONPTY_HELPER_ARCHITECTURE}\n`, "ascii"),
          )
          ? "ready"
          : "failed",
      );
    });
    timer = setTimeout(() => overflow(), 5_000);
    timer.unref?.();
  });
}

/** Exit 3 is authoritative only when the owned helper reports the one API-load
 * unsupported frame it can emit before creating an HPCON. No raw phase or
 * Win32 error code crosses the resolver boundary. */
function isExactUnsupportedProbeFrame(stdoutBytes: number, stderr: readonly Buffer[]): boolean {
  if (stdoutBytes !== 0) return false;
  const frame = Buffer.concat(stderr);
  const prefix = Buffer.from(`${CONPTY_HELPER_PROTOCOL}\terror\t1\t`, "ascii");
  if (
    frame.length < prefix.length + 2 ||
    !frame.subarray(0, prefix.length).equals(prefix) ||
    frame[frame.length - 1] !== 0x0a
  ) {
    return false;
  }
  const codeBytes = frame.subarray(prefix.length, frame.length - 1);
  if (
    codeBytes.length === 0 ||
    (codeBytes.length > 1 && codeBytes[0] === 0x30) ||
    codeBytes.some((byte) => byte < 0x30 || byte > 0x39)
  ) {
    return false;
  }
  const code = Number(codeBytes.toString("ascii"));
  return Number.isSafeInteger(code) && code >= 0 && code <= 0xffff_ffff;
}

export interface ConptyControlState {
  started: boolean;
  childPid: number | null;
  error: { phase: number; code: number } | null;
  malformed: boolean;
}

/** Bounded parser for helper-only stderr. It never returns raw bytes. */
export function createConptyControlParser(limit = 4_096): {
  push(chunk: Buffer): void;
  finish(): ConptyControlState;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  return {
    push(chunk) {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > limit) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(Buffer.from(chunk));
    },
    finish() {
      const state: ConptyControlState = {
        started: false,
        childPid: null,
        error: null,
        malformed: overflow,
      };
      if (overflow) return state;
      const text = Buffer.concat(chunks).toString("ascii");
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        const fields = line.split("\t");
        if (fields[0] !== CONPTY_HELPER_PROTOCOL) {
          state.malformed = true;
          continue;
        }
        if (fields[1] === "started" && fields.length === 3) {
          const pid = Number(fields[2]);
          if (state.started || !Number.isSafeInteger(pid) || pid <= 0) state.malformed = true;
          else {
            state.started = true;
            state.childPid = pid;
          }
          continue;
        }
        if (fields[1] === "error" && fields.length === 4) {
          const phase = Number(fields[2]);
          const code = Number(fields[3]);
          if (
            state.error !== null ||
            !Number.isSafeInteger(phase) ||
            phase < 1 ||
            phase > 10 ||
            !Number.isSafeInteger(code) ||
            code < 0 ||
            code > 0xffff_ffff
          ) {
            state.malformed = true;
          } else {
            state.error = { phase, code };
          }
          continue;
        }
        state.malformed = true;
      }
      if (!state.started && state.error === null) state.malformed = true;
      return state;
    },
  };
}
