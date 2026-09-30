/**
 * `claudexor profiles login cursor <profile-id>` (#363).
 *
 * The vendor's interactive login still runs in THIS terminal, but as a
 * daemon-managed setup job: the CLI creates a `client_pty` job for the named
 * binding and attaches this terminal through the one setup-attach owner. The
 * daemon's durable setup lifecycle then owns everything a login can outdate —
 * the execution permit that opens the credential-mutation window, the process
 * group and terminal doctor-probe verification — so
 * neither this client's death, nor its terminal's, nor a signal to its process
 * group can leave the daemon's credential observers unaware of the login.
 *
 * This client only attaches, turns Ctrl-C into a daemon-side cancel (the
 * daemon terminates the vendor's process group and proves it empty), and
 * reports the job's durable outcome. `--json` retains its existing refusal
 * and never prepares or starts a login.
 */
import { existsSync } from "node:fs";
import { ControlSetupJob } from "@claudexor/schema";
import { CliError, renderCliFailure } from "./cli-error.js";
import { print, printUsageError } from "./cli-io.js";
import { type ControlApiAddress, controlApiFetch } from "./live.js";
import {
  attachSetupJob,
  setupRecoveryHint,
  setupRunnerResultPath,
} from "./setup-attach-command.js";

const TERMINAL_STATES = new Set<ControlSetupJob["state"]>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted_unknown",
  "not_supported",
]);
const POLL_MS = 250;
/** Exit status of a login the operator interrupted (128 + SIGINT). */
const INTERRUPTED_EXIT = 130;

export interface ProfileLoginAttachDeps {
  ensureDaemon: () => Promise<{ addr: ControlApiAddress }>;
  /** The attached terminal runner's lifetime (default: the setup-attach owner). */
  attach?: (addr: ControlApiAddress, jobId: string) => Promise<number>;
  /** Whether the job's runner left its hash-bound result receipt. */
  receiptExists?: (jobId: string) => boolean;
  /** Subscribe to the operator's interrupt; returns the unsubscribe. */
  onInterrupt?: (handler: () => void) => () => void;
  pollMs?: number;
}

export interface ProfileLoginAttachInput {
  harness: string;
  profileId: string;
  json: boolean;
  /** The row's post-login status line (the Accounts projection re-read). */
  statusLine: () => Promise<string>;
}

async function jobRequest(
  addr: ControlApiAddress,
  path: string,
  init?: RequestInit,
): Promise<ControlSetupJob> {
  const response = await controlApiFetch(addr, path, init);
  if (!response.ok) {
    throw new CliError(
      "operational",
      `setup job request ${path} failed (${response.status}): ${await response.text()}`,
    );
  }
  return ControlSetupJob.parse(await response.json());
}

export async function profileLoginViaSetupJob(
  input: ProfileLoginAttachInput,
  deps: ProfileLoginAttachDeps,
): Promise<number> {
  const { harness, profileId, json } = input;
  if (json) return printUsageError(true, "profiles login is interactive and cannot use --json");
  const label = `${harness}/${profileId}`;
  const { addr } = await deps.ensureDaemon();
  let job: ControlSetupJob;
  try {
    job = await jobRequest(addr, "/setup/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness,
        action: "login",
        authRequest: "subscription",
        profileId,
        transport: "client_pty",
      }),
    });
  } catch (error) {
    return renderCliFailure(json, error, { messagePrefix: `could not start ${label} login:` });
  }
  if (TERMINAL_STATES.has(job.state)) {
    print(`${label} login was not started (${job.jobId}): ${job.message}`);
    if (job.outcome?.reason === "termination_unconfirmed") print(setupRecoveryHint(job.jobId));
    return 1;
  }
  print(`${label} login is managed by claudexord as ${job.jobId}; it runs in this terminal.`);

  let cancel: Promise<unknown> | null = null;
  const requestCancel = () => {
    cancel ??= jobRequest(addr, `/setup/jobs/${encodeURIComponent(job.jobId)}/cancel`, {
      method: "POST",
    }).catch((error) => {
      renderCliFailure(false, error, {
        messagePrefix: `could not deliver cancellation for ${job.jobId}; the daemon still owns the login. ${setupRecoveryHint(job.jobId)}`,
      });
    });
    return cancel;
  };
  let interrupted = false;
  const unsubscribe = (
    deps.onInterrupt ??
    ((handler) => {
      const signals = ["SIGINT", "SIGHUP", "SIGTERM"] as const;
      for (const signal of signals) process.on(signal, handler);
      return () => {
        for (const signal of signals) process.off(signal, handler);
      };
    })
  )(() => {
    // A second signal leaves at once; the daemon still owns the job.
    if (interrupted) process.exit(INTERRUPTED_EXIT);
    interrupted = true;
    void requestCancel();
  });
  try {
    try {
      await (deps.attach ?? attachSetupJob)(addr, job.jobId);
    } catch (error) {
      // Nothing was launched from this terminal (not attachable, already
      // claimed by another terminal, no runner): the job stays the daemon's.
      return renderCliFailure(false, error, {
        messagePrefix: `could not attach this terminal to ${job.jobId}:`,
      });
    }
    // The runner persists its result receipt BEFORE it exits. An attachment
    // that ended without one ended before the vendor did: the daemon
    // terminates the job's process group and proves it empty.
    const receiptExists =
      deps.receiptExists ?? ((jobId: string) => existsSync(setupRunnerResultPath(jobId)));
    if (interrupted || !receiptExists(job.jobId)) {
      if (!interrupted)
        print(
          `the terminal attachment ended before the ${label} login finished; cancelling ${job.jobId}.`,
        );
      await requestCancel();
    }
    for (;;) {
      try {
        job = await jobRequest(addr, `/setup/jobs/${encodeURIComponent(job.jobId)}`);
      } catch (error) {
        return renderCliFailure(false, error, {
          messagePrefix: `lost the daemon while ${job.jobId} was finishing (it remains daemon-owned):`,
        });
      }
      if (TERMINAL_STATES.has(job.state)) break;
      await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? POLL_MS));
    }
  } finally {
    unsubscribe();
  }
  if (job.state !== "succeeded") print(`${label} login ${job.state}: ${job.message}`);
  if (job.outcome?.reason === "termination_unconfirmed") print(setupRecoveryHint(job.jobId));
  print(await input.statusLine());
  if (interrupted) return INTERRUPTED_EXIT;
  return job.state === "succeeded" ? 0 : 1;
}
