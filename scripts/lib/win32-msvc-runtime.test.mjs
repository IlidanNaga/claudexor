import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dumpbinDependencyBasenames,
  dynamicCrtDependencies,
  sanitizedMsvcEnvironment,
} from "./win32-msvc-runtime.mjs";

describe("Win32 MSVC runtime build contract", () => {
  it("passes the MSVC paths and the ConPTY skip switch through Turbo builds", () => {
    const turboConfig = JSON.parse(
      readFileSync(new URL("../../turbo.json", import.meta.url), "utf8"),
    );

    // Containment, not exact equality: this pins the CONTRACT (what must
    // survive Turbo's strict env mode), not whichever unrelated switch the
    // list happens to also carry. The compiling lane needs the MSVC trio;
    // the release job that promotes assembled authoritative bytes needs the
    // skip switch, or it rebuilds the helper on a runner with no MSVC.
    const passThrough = turboConfig.tasks.build.passThroughEnv;
    for (const name of ["INCLUDE", "LIB", "LIBPATH", "CLAUDEXOR_SKIP_WIN32_CONPTY_BUILD"]) {
      expect(passThrough).toContain(name);
    }
  });

  it("removes inherited compiler flag channels case-insensitively", () => {
    expect(
      sanitizedMsvcEnvironment({
        Path: "C:\\tools",
        CL: "/MD",
        cl: "/Od",
        _CL_: "/link /DEFAULTLIB:msvcrt",
        _cl_: "/DOVERRIDE",
        INCLUDE: "C:\\include",
      }),
    ).toEqual({ Path: "C:\\tools", INCLUDE: "C:\\include" });
  });

  it("classifies dependency basenames without depending on dumpbin prose", () => {
    const dependencies = dumpbinDependencyBasenames(`
Microsoft (R) COFF/PE Dumper Version 14

  Abbild hat die folgenden Abhängigkeiten:

    KERNEL32.dll
    USER32.dll
    VCRUNTIME140_1.dll
    api-ms-win-crt-runtime-l1-1-0.dll

  Résumé
`);

    expect(dependencies).toEqual([
      "KERNEL32.dll",
      "USER32.dll",
      "VCRUNTIME140_1.dll",
      "api-ms-win-crt-runtime-l1-1-0.dll",
    ]);
    expect(dynamicCrtDependencies(dependencies)).toEqual([
      "VCRUNTIME140_1.dll",
      "api-ms-win-crt-runtime-l1-1-0.dll",
    ]);
  });

  it("allows ordinary system imports and rejects VC/UCRT runtime families", () => {
    expect(
      dynamicCrtDependencies(["KERNEL32.dll", "USER32.dll", "api-ms-win-core-synch-l1-2-0.dll"]),
    ).toEqual([]);
    expect(
      dynamicCrtDependencies([
        "MSVCP140_ATOMIC_WAIT.dll",
        "msvcrt.dll",
        "ucrtbased.dll",
        "CONCRT140.dll",
        "VCOMP140D.dll",
      ]),
    ).toEqual([
      "MSVCP140_ATOMIC_WAIT.dll",
      "msvcrt.dll",
      "ucrtbased.dll",
      "CONCRT140.dll",
      "VCOMP140D.dll",
    ]);
  });
});
