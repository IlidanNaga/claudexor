#!/usr/bin/env node
/**
 * Windows local Codex install proof (CI, `windows-test` lane).
 *
 * Runs ON the exact embedded Node the lane stages (`node.exe` next to its own
 * `node_modules/npm/bin/npm-cli.js`) and proves the production path against
 * the real registry, with no `node`/`npm` on PATH and an isolated
 * profile/config root:
 *  1. `claudexor harness install codex --target local --yes --json` succeeds;
 *  2. the receipt is exactly the embedding-host contract (no extra keys) and
 *     names the package-native `codex.exe` inside the managed toolchain root;
 *  3. that image answers `--version` with the pin, executed directly AND by
 *     bare name on the shared harness PATH — the spawn doctor, login, run and
 *     quota perform, without a shell and without any `.cmd` shim;
 *  4. a second install is the idempotent recheck; `claudexor doctor --json`
 *     reports codex installed at that image (auth is a separate lane).
 * Anything short of that exits non-zero with the observed evidence.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RECEIPT_FIELDS = [
  "ok",
  "dryRun",
  "exitCode",
  "target",
  "harness",
  "command",
  "installLocation",
  "installedBinary",
  "installedVersion",
  "pinnedVersion",
  "verification",
].sort();
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5 * 60 * 1000;

function fail(message, evidence) {
  console.error(`windows-local-install-smoke FAILED: ${message}`);
  if (evidence !== undefined) console.error(evidence);
  process.exit(1);
}

function step(message) {
  console.log(`\n== ${message}`);
}

function envValue(name) {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === upper) return value;
  }
  return undefined;
}

if (process.platform !== "win32") fail(`this proof runs on win32 only (got ${process.platform})`);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "packages", "cli", "dist", "cli.js");
if (!existsSync(cli)) fail(`built CLI missing at ${cli} (run pnpm build first)`);
const embeddedNpm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
if (!existsSync(embeddedNpm)) {
  fail(
    `the runner Node has no embedded npm-cli.js at ${embeddedNpm}; stage the official zip layout`,
  );
}

// realpath.native: a `%TEMP%` 8.3 short spelling must not leak into any path
// the engine later canonicalizes (the 3.4.1 Windows lane lesson).
const base = realpathSync.native(process.env.RUNNER_TEMP ?? tmpdir());
const root = mkdtempSync(join(base, "claudexor-win-local-install-"));
const home = join(root, "home");
const configDir = join(root, "config");
const temp = join(root, "tmp");
for (const dir of [
  home,
  configDir,
  temp,
  join(home, "AppData", "Roaming"),
  join(home, "AppData", "Local"),
]) {
  mkdirSync(dir, { recursive: true });
}
const systemRoot = envValue("SystemRoot") ?? "C:\\Windows";
const env = {
  // Windows process environment the OS itself resolves against — and NO
  // node/npm on PATH: the installer must use the runner Node's own npm-cli.js.
  SystemRoot: systemRoot,
  SystemDrive: envValue("SystemDrive") ?? "C:",
  windir: envValue("windir") ?? systemRoot,
  ComSpec: envValue("ComSpec") ?? join(systemRoot, "System32", "cmd.exe"),
  PATHEXT: envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD",
  PATH: [
    join(systemRoot, "System32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ].join(";"),
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  TEMP: temp,
  TMP: temp,
  CLAUDEXOR_CONFIG_DIR: configDir,
};
for (const proxy of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]) {
  const value = envValue(proxy);
  if (value !== undefined) env[proxy] = value;
}

step("no ambient node/npm is reachable from the proof environment");
for (const tool of ["node", "npm"]) {
  // Node's spawn cannot execute npm.cmd without a shell; ENOENT alone could
  // misreport that shim as absent. Windows where.exe observes PATHEXT too.
  const where = spawnSync(join(systemRoot, "System32", "where.exe"), [tool], {
    env,
    encoding: "utf8",
  });
  if (where.error || where.status !== 1) {
    fail(`${tool} is reachable or where.exe could not prove absence`, {
      status: where.status,
      error: where.error?.message,
      stdout: where.stdout,
    });
  }
  const probe = spawnSync(tool, ["--version"], { env, encoding: "utf8" });
  if (probe.error?.code !== "ENOENT") {
    fail(`${tool} is reachable on the proof PATH (status ${probe.status})`, probe.stdout);
  }
  console.log(`${tool}: not on PATH (including .cmd/.ps1), as required`);
}

function runCli(args, timeoutMs) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    env,
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`claudexor ${args.join(" ")} could not run: ${result.error.message}`);
  return result;
}

function parseSingleJson(label, stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    fail(`${label} stdout is not exactly one JSON object: ${error.message}`, stdout);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    fail(`${label} stdout is not a JSON object`, stdout);
  }
  return payload;
}

step("claudexor harness install codex --target local --yes --json");
const install = runCli(
  ["harness", "install", "codex", "--target", "local", "--yes", "--json"],
  INSTALL_TIMEOUT_MS,
);
const receipt = parseSingleJson("harness install", install.stdout);
console.log(JSON.stringify(receipt, null, 2));
if (install.status !== 0 || receipt.ok !== true) {
  fail(`install exited ${install.status} with ok=${String(receipt.ok)}`, receipt);
}
const keys = Object.keys(receipt).sort();
if (JSON.stringify(keys) !== JSON.stringify(RECEIPT_FIELDS)) {
  fail(`receipt keys differ from the embedding-host contract`, {
    expected: RECEIPT_FIELDS,
    actual: keys,
  });
}
if (
  receipt.dryRun !== false ||
  receipt.exitCode !== 0 ||
  receipt.target !== "local" ||
  receipt.harness !== "codex" ||
  receipt.verification !== "release_verified" ||
  typeof receipt.pinnedVersion !== "string" ||
  receipt.installedVersion !== receipt.pinnedVersion
) {
  fail("receipt facts do not match the local codex contract", receipt);
}
const installedBinary = receipt.installedBinary;
if (
  typeof installedBinary !== "string" ||
  !isAbsolute(installedBinary) ||
  !existsSync(installedBinary)
) {
  fail(`installedBinary is not an existing absolute path: ${String(installedBinary)}`);
}
if (basename(installedBinary).toLowerCase() !== "codex.exe") {
  fail(`installedBinary is not the native image: ${installedBinary}`);
}

const core = await import(
  pathToFileURL(join(repoRoot, "packages", "core", "dist", "index.js")).href
);
const expectedImage = join(
  core.windowsNativeImageDir(core.managedNodeRoot(home), "@openai/codex", process.arch),
  "codex.exe",
);
if (installedBinary.toLowerCase() !== expectedImage.toLowerCase()) {
  fail("installedBinary is not the package-native image the shared resolver owns", {
    installedBinary,
    expectedImage,
  });
}
console.log(`installedBinary is the package-native image: ${installedBinary}`);

step("the image answers --version with the pin, directly and by bare name on the harness PATH");
const direct = spawnSync(installedBinary, ["--version"], {
  env,
  encoding: "utf8",
  timeout: PROBE_TIMEOUT_MS,
});
if (direct.status !== 0 || !direct.stdout.includes(receipt.pinnedVersion)) {
  fail(`direct --version did not report ${receipt.pinnedVersion}`, {
    status: direct.status,
    stdout: direct.stdout,
    stderr: direct.stderr,
  });
}
console.log(`direct: ${direct.stdout.trim()}`);
const resolved = core.resolveHarnessBinary("codex", env, process.execPath);
if (typeof resolved !== "string" || resolved.toLowerCase() !== installedBinary.toLowerCase()) {
  fail('resolveHarnessBinary("codex") does not pick the installed image', {
    resolved,
    installedBinary,
  });
}
const byName = spawnSync("codex", ["--version"], {
  env: core.harnessRuntimeEnv(env, process.execPath),
  encoding: "utf8",
  timeout: PROBE_TIMEOUT_MS,
});
if (byName.error || byName.status !== 0 || !byName.stdout.includes(receipt.pinnedVersion)) {
  fail("bare `codex --version` on the shared harness PATH failed (no shell, no shim)", {
    error: byName.error?.message,
    status: byName.status,
    stdout: byName.stdout,
    stderr: byName.stderr,
  });
}
console.log(`by name on the harness PATH: ${byName.stdout.trim()}`);

step("a second install is the idempotent recheck");
const again = runCli(
  ["harness", "install", "codex", "--target", "local", "--yes", "--json"],
  INSTALL_TIMEOUT_MS,
);
const recheck = parseSingleJson("second harness install", again.stdout);
if (again.status !== 0 || recheck.ok !== true || recheck.installedBinary !== installedBinary) {
  fail("the second install did not recheck the same image", recheck);
}

step("claudexor doctor --json reports codex installed at that image (auth is a separate lane)");
const doctor = runCli(["doctor", "--json"], PROBE_TIMEOUT_MS);
const report = parseSingleJson("doctor", doctor.stdout);
const codex = Array.isArray(report.harnesses)
  ? report.harnesses.find((h) => h?.id === "codex")
  : undefined;
if (!codex) fail("doctor --json has no codex entry", report);
const installed = Array.isArray(codex.checks)
  ? codex.checks.find((c) => c?.id === "installed")
  : undefined;
console.log(
  JSON.stringify({ status: codex.status, checks: codex.checks, reasons: codex.reasons }, null, 2),
);
if (!installed || installed.status !== "pass")
  fail("doctor: codex `installed` check did not pass", codex);
if (
  typeof installed.detail !== "string" ||
  !installed.detail.toLowerCase().includes(installedBinary.toLowerCase())
) {
  fail("doctor: the installed check does not name the package-native image", installed);
}

step("stop the isolated daemon the doctor started");
const stop = runCli(["daemon", "stop", "--json"], PROBE_TIMEOUT_MS);
const stopped = parseSingleJson("daemon stop", stop.stdout);
if (stop.status !== 0 || stopped.ok !== true)
  fail("daemon stop did not confirm termination", stopped);

console.log(
  `\nwindows-local-install-smoke: OK (codex ${receipt.pinnedVersion} at ${installedBinary})`,
);
