#!/usr/bin/env node
import {
  constants,
  accessSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyWin32ConptyHelperCustody } from "./lib/win32-conpty-artifact.mjs";

const helperRelativePath = "dist/native/claudexor-process-identity";
const builtIndexRelativePath = "dist/process-identity.js";
const tarHelperPath = `package/${helperRelativePath}`;
const conptyRelativePath = "dist/native/claudexor-conpty-helper.exe";
const tarConptyPath = `package/${conptyRelativePath}`;

const [mode, input, ...extra] = process.argv.slice(2);
if (!((mode === "--built-package" || mode === "--tarball") && input)) {
  fail(
    "usage: verify-npm-darwin-package.mjs (--built-package DIR | --tarball FILE) [--win32-helper-sha256 HEX]",
  );
}
let expectedWin32Sha256 = process.env.CLAUDEXOR_WIN32_CONPTY_SHA256 || undefined;
for (let index = 0; index < extra.length; index += 2) {
  if (extra[index] !== "--win32-helper-sha256" || !extra[index + 1]) {
    fail(`unexpected argument: ${extra[index] ?? "end"}`);
  }
  expectedWin32Sha256 = extra[index + 1];
}
if (process.platform !== "darwin") fail("Darwin package verification requires a macOS runner");

let packageRoot;
let cleanupRoot = null;
if (mode === "--built-package") {
  packageRoot = resolve(input);
} else {
  const tarball = resolve(input);
  const listing = run("/usr/bin/tar", ["-tvzf", tarball]);
  const helperLine = listing.split("\n").find((line) => line.trimEnd().endsWith(tarHelperPath));
  if (!helperLine) fail(`${basename(tarball)} does not contain ${tarHelperPath}`);
  const permissions = helperLine.trimStart().split(/\s+/, 1)[0] ?? "";
  if (!/^-.{2}x/.test(permissions)) {
    fail(
      `${tarHelperPath} is not owner-executable in the npm tarball (${permissions || "unknown"})`,
    );
  }
  const conptyLine = listing.split("\n").find((line) => line.trimEnd().endsWith(tarConptyPath));
  if (expectedWin32Sha256 && !conptyLine) {
    fail(`${basename(tarball)} does not contain required ${tarConptyPath}`);
  }
  if (conptyLine) {
    const conptyPermissions = conptyLine.trimStart().split(/\s+/, 1)[0] ?? "";
    if (!/^-.{2}x/.test(conptyPermissions)) {
      fail(`${tarConptyPath} is not owner-executable in the npm tarball`);
    }
  }
  cleanupRoot = mkdtempSync(join(tmpdir(), "claudexor-npm-darwin-"));
  run("/usr/bin/tar", ["-xzf", tarball, "-C", cleanupRoot]);
  packageRoot = join(cleanupRoot, "package");
}

try {
  const helper = join(packageRoot, helperRelativePath);
  accessSync(helper, constants.X_OK);
  if ((statSync(helper).mode & 0o100) === 0) fail(`${helperRelativePath} is not executable`);

  const architectures = new Set(run("/usr/bin/lipo", ["-archs", helper]).trim().split(/\s+/));
  if (!architectures.has("arm64") || !architectures.has("x86_64")) {
    fail(`${helperRelativePath} is not a universal arm64+x86_64 binary`);
  }

  const conpty = join(packageRoot, conptyRelativePath);
  if (expectedWin32Sha256 || existsSync(conpty)) {
    if (!existsSync(conpty)) fail(`${conptyRelativePath} is required but missing`);
    const info = lstatSync(conpty);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o100) === 0) {
      fail(`${conptyRelativePath} is not a regular owner-executable package file`);
    }
    verifyWin32ConptyHelperCustody([conpty], expectedWin32Sha256);
  }

  const moduleUrl = `${pathToFileURL(join(packageRoot, builtIndexRelativePath)).href}?smoke=${Date.now()}`;
  const { ProcessIdentityService } = await import(moduleUrl);
  const observed = new ProcessIdentityService().read(process.pid);
  if (
    observed.status !== "known" ||
    observed.platform !== "darwin" ||
    observed.source !== "proc_pidinfo"
  ) {
    fail(
      `ProcessIdentityService.read(process.pid) did not use proc_pidinfo (${observed.status}/${observed.source ?? observed.reason ?? "unknown"})`,
    );
  }
  process.stdout.write(
    `Native npm package verified: Darwin identity${expectedWin32Sha256 ? " + exact Win32 ConPTY helper" : ""} (${mode.slice(2)})\n`,
  );
} finally {
  if (cleanupRoot) rmSync(cleanupRoot, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`${basename(command)} failed: ${lastLine(result.stderr)}`);
  }
  return result.stdout ?? "";
}

function lastLine(value) {
  return (
    String(value ?? "")
      .trim()
      .split("\n")
      .at(-1) ?? "unknown error"
  );
}

function fail(message) {
  console.error(`Darwin npm package verification failed: ${message}`);
  process.exit(1);
}
