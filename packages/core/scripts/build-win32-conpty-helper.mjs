#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWin32ConptyHelperCustody } from "../../../scripts/lib/win32-conpty-artifact.mjs";
import {
  dumpbinDependencyBasenames,
  dynamicCrtDependencies,
  sanitizedMsvcEnvironment,
} from "../../../scripts/lib/win32-msvc-runtime.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));

if (process.env.CLAUDEXOR_SKIP_WIN32_CONPTY_BUILD === "1" && !options.require) {
  process.stdout.write("ConPTY helper: build intentionally deferred to authoritative staging\n");
  process.exit(0);
}

if (process.platform !== "win32") {
  if (options.require) fail("the ConPTY helper can only be built with MSVC on Windows");
  process.stdout.write("ConPTY helper: non-Windows build skipped\n");
  process.exit(0);
}

const helperSource = resolve(packageRoot, "native", "claudexor-conpty-helper.c");
const helperOutput = resolve(
  options.out ?? resolve(packageRoot, "dist", "native", "claudexor-conpty-helper.exe"),
);
compile(helperSource, helperOutput, []);
verifyWin32ConptyHelperCustody([helperOutput]);
verifyProbe(helperOutput);

let fixtureOutput = null;
if (options.withTestChild || options.fixtureOut) {
  const fixtureSource = resolve(packageRoot, "native", "claudexor-conpty-test-child.c");
  fixtureOutput = resolve(
    options.fixtureOut ??
      resolve(packageRoot, "dist", "native-test", "claudexor-conpty-test-child.exe"),
  );
  compile(fixtureSource, fixtureOutput, ["shell32.lib", "user32.lib"]);
  verifyWin32ConptyHelperCustody([fixtureOutput]);
}

process.stdout.write(
  `ConPTY helper: built PE-x64 ${helperOutput} sha256:${sha256(helperOutput)}${
    fixtureOutput ? `; fixture ${fixtureOutput}` : ""
  }\n`,
);

function parseArgs(argv) {
  const parsed = {
    out: null,
    fixtureOut: null,
    require: false,
    withTestChild: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require") parsed.require = true;
    else if (argument === "--with-test-child") parsed.withTestChild = true;
    else if (argument === "--out" || argument === "--fixture-out") {
      const value = argv[index + 1];
      if (!value) fail(`${argument} requires a path`);
      if (argument === "--out") parsed.out = value;
      else parsed.fixtureOut = value;
      index += 1;
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function compile(source, output, libraries) {
  mkdirSync(dirname(output), { recursive: true });
  const buildEnvironment = sanitizedMsvcEnvironment(process.env);
  const suffix = `${process.pid}-${Date.now()}`;
  const temporary = resolve(dirname(output), `.${output.split(/[\\/]/).at(-1)}.${suffix}.tmp.exe`);
  const object = resolve(dirname(output), `.claudexor-conpty-${suffix}.obj`);
  rmSync(temporary, { force: true });
  rmSync(object, { force: true });
  const result = spawnSync(
    "cl.exe",
    [
      "/nologo",
      "/TC",
      "/std:c11",
      "/utf-8",
      "/O1",
      "/MT",
      "/Oi",
      "/Gy",
      "/Gw",
      "/GS",
      "/guard:cf",
      "/sdl",
      "/W4",
      "/WX",
      "/DUNICODE",
      "/D_UNICODE",
      "/D_WIN32_WINNT=0x0A00",
      `/Fo${object}`,
      source,
      `/Fe${temporary}`,
      "/link",
      "/Brepro",
      "/guard:cf",
      "/DYNAMICBASE",
      "/NXCOMPAT",
      "/HIGHENTROPYVA",
      "/CETCOMPAT",
      ...libraries,
    ],
    { encoding: "utf8", windowsHide: true, env: buildEnvironment },
  );
  rmSync(object, { force: true });
  if (result.status !== 0) {
    rmSync(temporary, { force: true });
    fail(result.stderr || result.stdout || `cl.exe failed for ${source}`);
  }
  if (!statSync(temporary).isFile() || statSync(temporary).size === 0) {
    rmSync(temporary, { force: true });
    fail(`MSVC produced no regular executable for ${source}`);
  }
  const dependencyError = verifyStaticCrtDependencies(temporary, buildEnvironment);
  if (dependencyError) {
    rmSync(temporary, { force: true });
    fail(dependencyError);
  }
  renameSync(temporary, output);
}

function verifyStaticCrtDependencies(path, environment) {
  const result = spawnSync("dumpbin.exe", ["/nologo", "/DEPENDENTS", path], {
    encoding: "utf8",
    windowsHide: true,
    env: environment,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error) return `dumpbin /DEPENDENTS failed for ${path}: ${result.error.message}`;
  if (result.status !== 0 || result.signal !== null) {
    return `dumpbin /DEPENDENTS failed for ${path} with status ${String(result.status)}`;
  }
  const dependencies = dumpbinDependencyBasenames(result.stdout ?? "");
  if (dependencies.length === 0) {
    return `dumpbin /DEPENDENTS reported no dependency basenames for ${path}`;
  }
  const dynamicCrt = dynamicCrtDependencies(dependencies);
  if (dynamicCrt.length > 0) {
    return `dynamic VC/UCRT dependency is forbidden for ${path}: ${dynamicCrt.join(", ")}`;
  }
  return null;
}

function verifyProbe(path) {
  const result = spawnSync(path, ["--probe"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 4_096,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.signal !== null) {
    fail(`ConPTY helper probe failed with status ${String(result.status)}`);
  }
  if ((result.stdout ?? "") !== "claudexor-conpty-helper-v1\tx64\n") {
    fail("ConPTY helper probe returned the wrong protocol or architecture marker");
  }
  if ((result.stderr ?? "").length !== 0) {
    fail("ConPTY helper probe emitted unexpected control diagnostics");
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fail(message) {
  process.stderr.write(`ConPTY helper build failed: ${String(message).trim()}\n`);
  process.exit(1);
}
