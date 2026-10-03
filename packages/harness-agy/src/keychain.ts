import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { canonicalIsolationLocator } from "@claudexor/core";
import { ensureCanonicalPrivateDirectory, redactSecrets } from "@claudexor/util";

const SECURITY_BINARY = "/usr/bin/security";
const SECURITY_TIMEOUT_MS = 5_000;
const configuredKeychains = new Set<string>();

export interface AgySecurityResult {
  status: number | null;
  detail?: string;
}

export type AgySecurityRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => AgySecurityResult;

export interface AgyKeychainOptions {
  platform?: NodeJS.Platform;
  runSecurity?: AgySecurityRunner;
}

/**
 * Typed, bounded setup result. `unsafe` means the profile path or target
 * identity is not proven and callers must refuse the vendor child; a false
 * value is a recoverable security-tool miss where agy's file fallback may
 * still keep authentication working.
 */
export class AgyProfileKeychainError extends Error {
  readonly code = "agy_profile_keychain_unavailable" as const;
  readonly unsafe: boolean;

  constructor(detail: string, options: { unsafe?: boolean } = {}) {
    super(`agy profile keychain setup failed: ${redactSecrets(detail).slice(0, 300)}`);
    this.name = "AgyProfileKeychainError";
    this.unsafe = options.unsafe === true;
  }
}

export function isAgyProfileKeychainUnsafe(error: unknown): boolean {
  return error instanceof AgyProfileKeychainError && error.unsafe;
}

/** The only keychain path agy may use for one named profile. */
export function agyProfileKeychainPath(profileHome: string): string {
  const home = canonicalIsolationLocator(profileHome, "credential profile Antigravity HOME");
  return join(home, "Library", "Keychains", "login.keychain-db");
}

/**
 * Prepare the private Darwin keychain declared by the agy capability profile.
 * Other platforms deliberately do nothing: Linux and Windows retain their
 * vendor-owned credential behavior. The helper never reads, copies, or
 * removes credential items; agy itself remains the only item owner. Creation
 * uses a neutral bootstrap filename before adopting login.keychain-db because
 * Apple's create operation treats the latter name as a user-list entry on the
 * supported Darwin path.
 */
export function prepareAgyProfileKeychain(
  profileHome: string,
  options: AgyKeychainOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return;
  ensureAgyProfileKeychain(profileHome, { ...options, platform });
}

/**
 * Low-level Darwin ensure used by the adapter's production seams and tests.
 * The caller has already established that this is the private agy route.
 */
export function ensureAgyProfileKeychain(
  profileHome: string,
  options: AgyKeychainOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return;

  let home: string;
  let keychain: string;
  try {
    home = canonicalIsolationLocator(profileHome, "credential profile Antigravity HOME");
    keychain = agyProfileKeychainPath(home);
  } catch (error) {
    throw new AgyProfileKeychainError(error instanceof Error ? error.message : String(error), {
      unsafe: true,
    });
  }
  try {
    try {
      ensureOwnedDirectory(home, platform);
      ensureOwnedDirectory(join(home, "Library"), platform);
      ensureOwnedDirectory(join(home, "Library", "Keychains"), platform);
    } catch (error) {
      throw new AgyProfileKeychainError(error instanceof Error ? error.message : String(error), {
        unsafe: true,
      });
    }

    let exists = validateKeychainFile(keychain, home, false);
    const runSecurity = options.runSecurity ?? defaultSecurityRunner;
    const env = securityEnv(home);
    if (!exists) {
      const bootstrap = temporaryKeychainPath(join(home, "Library", "Keychains"));
      if (bootstrap.includes("/login.keychain")) {
        throw new AgyProfileKeychainError(
          "profile keychain path would match Apple's login-keychain search-list heuristic",
          { unsafe: true },
        );
      }
      const bootstrapExists = validateKeychainFile(bootstrap, home, false);
      const created = bootstrapExists
        ? { status: 48, detail: "bootstrap keychain already exists" }
        : runSecurity(["create-keychain", "-p", "", bootstrap], env);
      const canonicalAfterCreate = validateKeychainFile(keychain, home, false);
      if (!canonicalAfterCreate) {
        let bootstrapReady = false;
        if (created.status !== 0) {
          // A concurrent process may have won creation with a
          // platform-specific already-exists status. Revalidation, not a
          // numeric status guess, is the idempotence authority.
          try {
            validateKeychainFile(bootstrap, home, true);
            bootstrapReady = true;
          } catch (error) {
            // A peer can adopt and remove the bootstrap file between our
            // status check and this validation. Recheck the canonical winner
            // only for that missing-file race; identity failures remain hard
            // refusals.
            if (pathIsMissing(bootstrap) && validateKeychainFile(keychain, home, false)) {
              exists = true;
            } else {
              // A failed create with no usable target is unsafe: spawning agy
              // would return to the missing-keychain prompt. Explicit security
              // errors remain recoverable only when a valid file exists.
              if (error instanceof AgyProfileKeychainError) throw error;
              throw new AgyProfileKeychainError(created.detail ?? "create-keychain failed", {
                unsafe: true,
              });
            }
          }
        } else {
          validateKeychainFile(bootstrap, home, true);
          bootstrapReady = true;
        }
        if (bootstrapReady) {
          adoptBootstrapKeychain(bootstrap, keychain, home);
          exists = true;
        }
      } else {
        // Another process completed the canonical rename while this process
        // was creating its neutral bootstrap file. The neutral file is ours;
        // remove it only after the canonical target is identity-checked.
        removeBootstrapKeychain(bootstrap, home);
        exists = true;
      }
      configuredKeychains.delete(keychain);
    }

    let unlockedBeforeSettings = false;
    if (!configuredKeychains.has(keychain)) {
      const unlocked = runSecurity(["unlock-keychain", "-p", "", keychain], env);
      if (unlocked.status !== 0) {
        throw new AgyProfileKeychainError(unlocked.detail ?? "unlock-keychain failed");
      }
      unlockedBeforeSettings = true;
      const settings = runSecurity(["set-keychain-settings", keychain], env);
      if (settings.status !== 0) {
        throw new AgyProfileKeychainError(settings.detail ?? "set-keychain-settings failed");
      }
      configuredKeychains.add(keychain);
    }

    // A login keychain can still be locked by sleep, logout, or an explicit
    // user action. Re-open it at every vendor-spawn boundary; the first-call
    // unlock above also makes set-keychain-settings safe on a locked file.
    if (!unlockedBeforeSettings) {
      const unlocked = runSecurity(["unlock-keychain", "-p", "", keychain], env);
      if (unlocked.status !== 0) {
        throw new AgyProfileKeychainError(unlocked.detail ?? "unlock-keychain failed");
      }
    }

    validateKeychainFile(keychain, home, true);
  } catch (error) {
    configuredKeychains.delete(keychain);
    if (error instanceof AgyProfileKeychainError) throw error;
    throw new AgyProfileKeychainError(error instanceof Error ? error.message : String(error), {
      unsafe: true,
    });
  }
}

function securityEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    USERPROFILE: home,
    PATH: "/usr/bin:/bin",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
  };
}

function defaultSecurityRunner(args: readonly string[], env: NodeJS.ProcessEnv): AgySecurityResult {
  try {
    execFileSync(SECURITY_BINARY, [...args], {
      env,
      stdio: "ignore",
      timeout: SECURITY_TIMEOUT_MS,
      windowsHide: true,
    });
    return { status: 0 };
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { status?: unknown }).status
        : null;
    return {
      status: typeof status === "number" ? status : null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function ensureOwnedDirectory(path: string, platform: NodeJS.Platform): void {
  try {
    ensureCanonicalPrivateDirectory(path, platform);
  } catch (error) {
    if (!(error instanceof Error) || !/EEXIST|already exists/i.test(error.message)) throw error;
    // Another process won the mkdir race. Re-run the full identity proof.
    ensureCanonicalPrivateDirectory(path, platform);
  }
}

function temporaryKeychainPath(directory: string): string {
  // Keep one deterministic neutral name so a crash between create and adopt
  // is recoverable on the next preparation rather than accumulating orphan
  // keychain databases. It deliberately does not contain "login.keychain",
  // the Apple Security heuristic that updates the user search list.
  return join(directory, ".agy-profile-bootstrap.keychain-db");
}

/**
 * Install the neutral-name keychain without calling a user-domain list
 * mutation. A hard link gives us an atomic no-replace destination on the
 * same APFS directory; the source is then removed, so the vendor sees one
 * canonical login.keychain-db path and no bootstrap alias remains.
 */
function adoptBootstrapKeychain(source: string, destination: string, home: string): void {
  try {
    linkSync(source, destination);
  } catch (error) {
    if (isAlreadyExists(error)) {
      validateKeychainFile(destination, home, true);
      removeBootstrapKeychain(source, home);
      return;
    }
    if (isMissing(error) && validateKeychainFile(destination, home, false)) {
      // A peer may have adopted and removed the bootstrap between our
      // identity check and this no-replace link. The canonical winner is
      // authoritative; do not turn that benign race into a profile refusal.
      return;
    }
    throw new AgyProfileKeychainError(error instanceof Error ? error.message : String(error), {
      unsafe: true,
    });
  }
  try {
    unlinkSync(source);
  } catch (error) {
    if (isMissing(error)) {
      validateKeychainFile(destination, home, true);
      return;
    }
    throw new AgyProfileKeychainError(error instanceof Error ? error.message : String(error), {
      unsafe: true,
    });
  }
  validateKeychainFile(destination, home, true);
}

function removeBootstrapKeychain(path: string, home: string): void {
  let exists = false;
  try {
    exists = validateKeychainFile(path, home, false);
  } catch (error) {
    if (error instanceof AgyProfileKeychainError) throw error;
    throw new AgyProfileKeychainError(error instanceof Error ? error.message : String(error), {
      unsafe: true,
    });
  }
  if (!exists) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw new AgyProfileKeychainError(error instanceof Error ? error.message : String(error), {
      unsafe: true,
    });
  }
}

function validateKeychainFile(path: string, home: string, required: boolean): boolean {
  const absolute = resolve(path);
  let named;
  try {
    named = lstatSync(absolute);
  } catch (error) {
    if (!required && isMissing(error)) return false;
    throw new AgyProfileKeychainError("private keychain path is missing or unreadable", {
      unsafe: true,
    });
  }
  if (named.isSymbolicLink() || !named.isFile()) {
    throw new AgyProfileKeychainError("private keychain path is not a regular file", {
      unsafe: true,
    });
  }
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDWR | constants.O_NOFOLLOW);
  } catch {
    throw new AgyProfileKeychainError("private keychain path cannot be opened safely", {
      unsafe: true,
    });
  }
  try {
    const opened = fstatSync(fd);
    const current = lstatSync(absolute);
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      realpathSync.native(absolute) !== absolute ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid()) ||
      !absolute.startsWith(resolve(home) + "/")
    ) {
      throw new AgyProfileKeychainError("private keychain identity is not canonical", {
        unsafe: true,
      });
    }
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  return true;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code === "ENOENT"
    : false;
}

function pathIsMissing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code === "EEXIST"
    : false;
}
