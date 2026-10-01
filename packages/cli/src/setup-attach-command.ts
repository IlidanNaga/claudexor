import { spawn, type SpawnOptions } from "node:child_process";
import { closeSync, constants, existsSync, openSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { ControlSetupJob } from "@claudexor/schema";
import { daemonDir } from "@claudexor/daemon";
import { type ParsedArgs } from "./args.js";
import { controlProblemError, renderCliFailure } from "./cli-error.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { type ControlApiAddress, controlApiFetch } from "./live.js";
import { resolveSetupLoginRunnerPath } from "./setup-job-support.js";
import { runnerBootstrapEnv } from "./setup-login-runner-support.js";

function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        process.stderr.write(`claudexor setup attach: runner exited on ${signal}\n`);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

export function setupRecoveryHint(jobId: string): string {
  return `Use claudexor setup cancel ${jobId} to stop it, or claudexor setup reconcile ${jobId} to check an unconfirmed termination; retry login after it finishes.`;
}

export function claimSetupAttachment(directory: string, jobId?: string): void {
  const path = join(directory, "client-pty-attached");
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `setup job${jobId ? ` ${jobId}` : ""} already has a client_pty attachment${jobId ? `. ${setupRecoveryHint(jobId)}` : ""}`,
    );
  }
  closeSync(descriptor);
}

export interface SetupAttachRunnerInvocation {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/**
 * Windows must keep the login worker in the terminal that attached the job:
 * entering `--worker` directly avoids the detached bootstrap hop that daemon-
 * hosted jobs require. POSIX retains the existing bootstrap invocation.
 */
export function setupAttachRunnerInvocation(input: {
  platform: NodeJS.Platform;
  nodePath: string;
  runnerPath: string;
  manifestPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): SetupAttachRunnerInvocation {
  if (input.platform === "win32") {
    return {
      command: input.nodePath,
      args: [input.runnerPath, "--worker", input.manifestPath],
      options: {
        cwd: input.cwd,
        stdio: "inherit",
        env: runnerBootstrapEnv(input.env),
        detached: false,
      },
    };
  }
  return {
    command: input.nodePath,
    args: [input.runnerPath, input.manifestPath],
    options: { cwd: input.cwd, stdio: "inherit", env: input.env },
  };
}

export interface SetupAttachOptions {
  /** The adjacent login runner (default: resolved next to this module). */
  runnerPath?: string;
  /** The daemon's setup artifact root (default: `<daemonDir>/setup-artifacts`). */
  artifactRoot?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Where a sealed job's runner leaves its hash-bound result receipt. */
export function setupRunnerResultPath(jobId: string, artifactRoot?: string): string {
  return join(artifactRoot ?? join(daemonDir(), "setup-artifacts"), jobId, "runner-result.json");
}

/**
 * Attach THIS terminal to one sealed client_pty setup job and run its login
 * runner to exit. The job must still be attachable, the sealed manifest must
 * exist, and the one-use claim must succeed; the daemon owns everything else.
 */
export async function attachSetupJob(
  addr: ControlApiAddress,
  jobId: string,
  options: SetupAttachOptions = {},
): Promise<number> {
  const response = await controlApiFetch(addr, `/setup/jobs/${encodeURIComponent(jobId)}`);
  const body = (await response.json()) as {
    state?: string;
    phase?: string;
    transport?: string;
  };
  if (!response.ok) throw new Error(`setup job lookup failed (HTTP ${response.status})`);
  if (body.transport !== "client_pty") {
    throw new Error("setup job is not authorized for client_pty attachment");
  }
  if (
    !["queued", "running", "waiting_for_input"].includes(body.state ?? "") ||
    !["launching", "awaiting_user"].includes(body.phase ?? "")
  ) {
    throw new Error(
      `setup job ${jobId} is not attachable (${body.state ?? "unknown"}). ${setupRecoveryHint(jobId)}`,
    );
  }
  const artifactDirectory = join(
    options.artifactRoot ?? join(daemonDir(), "setup-artifacts"),
    jobId,
  );
  const manifest = join(artifactDirectory, "runner-manifest.json");
  if (!existsSync(manifest)) throw new Error("sealed setup manifest is unavailable");
  const runner = options.runnerPath ?? resolveSetupLoginRunnerPath();
  if (!existsSync(runner)) throw new Error("setup login runner is unavailable");
  // A sealed login job authorizes exactly one terminal runner. O_EXCL is the
  // cross-process fence; the marker intentionally survives a crashed client so
  // users cancel/recreate instead of accidentally launching the vendor login
  // twice against one daemon-owned job.
  claimSetupAttachment(artifactDirectory, jobId);
  const invocation = setupAttachRunnerInvocation({
    platform: options.platform ?? platform(),
    nodePath: process.execPath,
    runnerPath: runner,
    manifestPath: manifest,
    cwd: artifactDirectory,
    env: options.env ?? process.env,
  });
  return waitForChild(spawn(invocation.command, invocation.args, invocation.options));
}

/**
 * One owner for the interactive setup attachment role. The full CLI and the
 * packaged daemon bundle both enter here; neither re-authors daemon lookup,
 * the one-use claim, adjacent runner resolution, nor the Windows worker shape.
 */
export async function setupAttachCommand(argv: readonly string[], json: boolean): Promise<number> {
  const sub = argv[1];
  const jobId = argv[2];
  if (
    argv[0] !== "setup" ||
    sub !== "attach" ||
    typeof jobId !== "string" ||
    !/^setup-[A-Za-z0-9-]+$/.test(jobId) ||
    argv.length !== 3
  ) {
    return printUsageError(json, "usage: claudexor setup attach <jobId>");
  }
  if (json) {
    return printUsageError(
      true,
      "claudexor setup attach owns an interactive PTY and cannot use --json",
    );
  }
  const daemon = await connectDaemonIfRunning();
  if (!daemon) throw new Error("setup daemon is not running");
  return attachSetupJob(daemon.addr, jobId);
}

/** Full-CLI adapter over the shared raw-argv role owner. */
export async function setupCommand(
  args: Pick<ParsedArgs, "_">,
  json: boolean,
  connect: typeof connectDaemonIfRunning = connectDaemonIfRunning,
): Promise<number> {
  if (args._[1] === "attach") return setupAttachCommand(args._, json);
  const [, action, jobId] = args._;
  if (
    args._[0] !== "setup" ||
    (action !== "cancel" && action !== "reconcile") ||
    typeof jobId !== "string" ||
    !/^setup-[A-Za-z0-9-]+$/.test(jobId) ||
    args._.length !== 3
  )
    return printUsageError(json, "usage: claudexor setup attach|cancel|reconcile <jobId>");
  try {
    const daemon = await connect();
    if (!daemon) throw new Error("setup daemon is not running");
    const response = await controlApiFetch(
      daemon.addr,
      `/setup/jobs/${encodeURIComponent(jobId)}/${action}`,
      {
        method: "POST",
      },
    );
    const body: unknown = await response.json();
    if (!response.ok)
      throw controlProblemError(response.status, body, `setup ${action} failed for ${jobId}`);
    const job = ControlSetupJob.parse(body);
    if (json) printJson({ ok: true, job });
    else print(`${job.jobId}: ${job.state} (${job.phase}) — ${job.message}`);
    return 0;
  } catch (error) {
    return renderCliFailure(json, error, { messagePrefix: `setup ${action} ${jobId}:` });
  }
}
