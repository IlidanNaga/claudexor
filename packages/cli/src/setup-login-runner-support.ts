import type { ChildProcess } from "node:child_process";
import { WINDOWS_RUNTIME_ENV_KEYS, pickAllowlistedEnv } from "@claudexor/core";
import {
  SETUP_LOGIN_PROTOCOL_VERSION,
  atomicPrivateJson,
  type SetupLoginManifest,
  type SetupLoginRunnerResult,
} from "./setup-login-protocol.js";

export function persistRunnerResult(
  manifest: SetupLoginManifest,
  result: Omit<
    SetupLoginRunnerResult,
    "version" | "jobId" | "executionId" | "commandDigest" | "manifestDigest"
  >,
): void {
  atomicPrivateJson(manifest.resultPath, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: manifest.jobId,
    executionId: manifest.executionId,
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
    ...result,
  } satisfies SetupLoginRunnerResult);
}

export function persistRunnerFailure(
  manifest: SetupLoginManifest,
  now: () => Date,
  permitIssuedAt: string | null,
  errorCode: NonNullable<SetupLoginRunnerResult["errorCode"]>,
  outputTail?: string,
): void {
  persistRunnerCommandFailure(manifest, now, permitIssuedAt, errorCode, false, outputTail);
}

export function persistRunnerCommandFailure(
  manifest: SetupLoginManifest,
  now: () => Date,
  permitIssuedAt: string | null,
  errorCode: NonNullable<SetupLoginRunnerResult["errorCode"]>,
  commandStarted: boolean,
  outputTail?: string,
): void {
  persistRunnerResult(manifest, {
    permitIssuedAt,
    commandStarted,
    errorCode,
    exitCode: null,
    signal: null,
    finishedAt: now().toISOString(),
    ...(outputTail === undefined ? {} : { outputTail }),
  });
}

export function waitForRunnerExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
}

/** The bootstrap itself never needs model/provider credentials. */
export function runnerBootstrapEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return pickAllowlistedEnv(source, [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "SHELL",
    "USER",
    "LOGNAME",
    "CLAUDEXOR_CONFIG_DIR",
    "CLAUDEXOR_CODEX_NATIVE_HOME",
    "CLAUDEXOR_CLAUDE_NATIVE_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    ...WINDOWS_RUNTIME_ENV_KEYS,
  ]);
}
