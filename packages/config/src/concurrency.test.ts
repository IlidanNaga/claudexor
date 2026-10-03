import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigParseError, loadConfig, updateGlobalConfig } from "./index.js";
import { RuntimeConcurrencyCaps, concurrencyState } from "@claudexor/schema";

const vars = [
  "CLAUDEXOR_MAX_CONCURRENT",
  "CLAUDEXOR_MAX_PARALLEL_CANDIDATES",
  "CLAUDEXOR_MAX_DEEP_SCAN_WIDTH",
  "CLAUDEXOR_MAX_COUNCIL_MEMBERS",
];
describe("concurrency configuration contract", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cx-cap-config-"));
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", root);
    for (const name of vars) vi.stubEnv(name, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips explicit defaults while unrelated saves omit implicit defaults", () => {
    updateGlobalConfig((cfg) => cfg);
    const path = join(root, "config.yaml");
    expect(readFileSync(path, "utf8")).not.toContain("max_concurrent:");
    writeFileSync(path, "runtime:\n  max_concurrent: 24\n");
    updateGlobalConfig((cfg) => cfg);
    expect(readFileSync(path, "utf8")).toContain("max_concurrent: 24");
    expect(readFileSync(path, "utf8")).not.toContain("max_deep_scan_width:");
  });

  it.each(vars)("validates %s independently with typed config failures", (name) => {
    for (const raw of ["0", "-1", "1.5", "abc", "Infinity", "9007199254740992", ""]) {
      vi.stubEnv(name, raw);
      expect(() => loadConfig(root), raw).toThrow(ConfigParseError);
    }
    vi.stubEnv(name, "9007199254740991");
    expect(() => loadConfig(root)).not.toThrow();
  });

  it("uses env over YAML without rewriting it and compares all four caps", () => {
    const path = join(root, "config.yaml");
    const yaml = "runtime:\n  max_concurrent: 30\n";
    writeFileSync(path, yaml);
    vi.stubEnv("CLAUDEXOR_MAX_CONCURRENT", "48");
    expect(loadConfig(root).global.runtime.max_concurrent).toBe(48);
    expect(readFileSync(path, "utf8")).toBe(yaml);
    const caps = RuntimeConcurrencyCaps.parse({});
    expect(concurrencyState(caps, caps).restartRequired).toBe(false);
    for (const key of Object.keys(caps) as Array<keyof RuntimeConcurrencyCaps>) {
      expect(concurrencyState({ ...caps, [key]: caps[key] + 1 }, caps).restartRequired).toBe(true);
    }
  });
});
