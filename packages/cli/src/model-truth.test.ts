import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// HERMETIC vendor stubs (the settings-service suite's pattern): the codex and
// agy adapters resolve their binaries at module load and discover() requires
// `--version` to answer; without stubs this suite would silently depend on a
// dev machine's installs. The manifest hint lists are what is exercised here.
const stubDir = mkdtempSync(join(tmpdir(), "claudexor-model-truth-"));
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));
function stub(name: string, version: string): string {
  const bin = join(stubDir, name);
  writeFileSync(
    bin,
    `#!/bin/sh\ncase "$1" in\n  --version) echo "${version}" ;;\n  *) exit 1 ;;\nesac\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}
process.env["CLAUDEXOR_CODEX_BIN"] = stub("codex", "codex-cli 0.0.0-stub");
process.env["CLAUDEXOR_AGY_BIN"] = stub("agy", "agy 0.0.0-stub");
const { checkHarnessModel, checkHarnessModelTruth, harnessModelTruth, harnessModels } =
  await import("./registry.js");

describe("harness model truth = list + declaration (the ONE settings/doctor/catalog gate, INV-104)", () => {
  it("codex: an unlisted model is admitted with the note (advisory), a listed one silently", async () => {
    const truth = await harnessModelTruth("codex", process.cwd(), true);
    expect(truth.absence).toBe("advisory");
    // The unscoped query reads the manifest hints (the live producer is native-route only).
    expect(truth.response.source).toBe("manifest");
    expect(truth.response).toEqual(await harnessModels("codex", process.cwd(), true));
    expect(checkHarnessModelTruth(truth, "gpt-ghost-9000")).toEqual({
      status: "ok",
      unverified: true,
      message: expect.stringMatching(
        /^model "gpt-ghost-9000" is not in this harness's manifest known-model list; .*forwarded to the vendor$/,
      ),
    });
    expect(checkHarnessModelTruth(truth, "gpt-5.5")).toEqual({ status: "ok", message: null });
  }, 30_000);

  it("agy: an unlisted model is refused (authoritative by omission), a listed one passes", async () => {
    const { truth, check } = await checkHarnessModel(
      "agy",
      "ghost-model-9000",
      process.cwd(),
      true,
    );
    expect(truth.source).toBe("manifest");
    expect(check.status).toBe("rejected");
    expect(check.message).toContain("manifest known-model list");
    expect(
      (await checkHarnessModel("agy", "gemini-3.7-flash-high", process.cwd(), true)).check,
    ).toEqual({ status: "ok", message: null });
  }, 30_000);

  it("an unknown harness id has no truth at all and refuses every explicit model", async () => {
    const { truth, check } = await checkHarnessModel("no-such-harness", "anything", process.cwd());
    expect(truth).toEqual({
      harnessId: "no-such-harness",
      models: [],
      source: "none",
      verifiedAgainst: null,
    });
    expect(check.status).toBe("rejected");
  });
});
