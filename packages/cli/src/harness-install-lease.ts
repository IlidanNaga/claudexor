import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HarnessInstallLease {
  release(): void;
}

interface HarnessInstallLeaseOwner {
  pid: number;
  token: string;
}

export const HARNESS_INSTALL_LOCK_TIMEOUT_MS = 120_000;
const INSTALL_LOCK_POLL_MS = 100;
const INSTALL_LOCK_OWNER_GRACE_MS = 5_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function readInstallLeaseOwner(path: string): HarnessInstallLeaseOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      pid?: unknown;
      token?: unknown;
    };
    if (
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.token !== "string" ||
      value.token.length === 0
    ) {
      return null;
    }
    return { pid: Number(value.pid), token: value.token };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function installLockError(path: string, stale: boolean): Error {
  const code = stale ? "install_lock_stale" : "install_lock_busy";
  const message = stale
    ? `a stale claudexor harness install lock remains at ${path}; verify no installer is running, remove that exact directory, and retry`
    : `another claudexor harness install still owns ${path}; if this persists after that installer exits, verify no installer is running, remove that exact directory, and retry`;
  return Object.assign(new Error(message), { code });
}

/** One user-scoped, cross-process lease covers every shared install prefix.
 * Waiters never unlink or rename a stale observation: doing so cannot be made
 * compare-and-swap safe with Node's portable filesystem API and could delete a
 * replacement owner's live lease. A dead or old owner-less lock fails closed
 * with an exact manual remedy; ordinary live owners retain the bounded wait. */
export function acquireHarnessInstallLease(home: string, timeoutMs: number): HarnessInstallLease {
  const lockRoot = join(home, ".claudexor");
  const path = join(lockRoot, "harness-install.lock");
  const ownerPath = join(path, "owner.json");
  const token = randomUUID();
  const owner: HarnessInstallLeaseOwner = { pid: process.pid, token };
  const deadline = Date.now() + Math.max(0, timeoutMs);
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      try {
        writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          const current = readInstallLeaseOwner(ownerPath);
          if (current?.pid === process.pid && current.token === token) {
            rmSync(path, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = readInstallLeaseOwner(ownerPath);
    let stale = existing !== null && !processIsAlive(existing.pid);
    if (existing === null) {
      try {
        stale = Date.now() - statSync(path).mtimeMs >= INSTALL_LOCK_OWNER_GRACE_MS;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    if (stale) throw installLockError(path, true);
    if (Date.now() >= deadline) throw installLockError(path, false);
    Atomics.wait(sleepCell, 0, 0, Math.min(INSTALL_LOCK_POLL_MS, deadline - Date.now()));
  }
}
