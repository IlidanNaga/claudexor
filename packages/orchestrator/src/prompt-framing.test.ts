import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import { newId } from "@claudexor/util";
import { CatalogInputLimit } from "@claudexor/schema";
import { catalogInputLimits, promptWithPointers, threadContextPointer } from "./prompt-framing.js";

it("uses actual runtime path and id producers for ordinary thread ASK framing, without creating a run", () => {
  const root = join(process.env.CLAUDEXOR_CONFIG_DIR!, "配置😀");
  process.env.CLAUDEXOR_CONFIG_DIR = root;
  const native = {
    scope: "turn_text",
    unit: "unicode_scalars",
    limit: 1048576,
    source: "fixture.rpc",
    verified_against: "fixture1",
  } as const;
  const observed = CatalogInputLimit.parse(catalogInputLimits([native])[0]);
  const paths = new ArtifactStore("/some/other/project").runPaths(newId("run"));
  const pointer = threadContextPointer(join(paths.contextDir, "THREAD.md"));
  const budget = observed.askPromptBudget!;
  expect(budget.shape).toBe("ordinary_initial_attempt");
  expect(budget.engineOverheadMax).toBe(Array.from(promptWithPointers("😀", pointer)).length - 1);
  const fits = "界".repeat(native.limit - budget.engineOverheadMax);
  expect(Array.from(promptWithPointers(fits, pointer))).toHaveLength(native.limit);
  expect(Array.from(promptWithPointers(fits + "😀", pointer))).toHaveLength(native.limit + 1);
  expect(promptWithPointers("tiny", null)).toBe("tiny");
  expect(existsSync(root)).toBe(false);
  expect(observed).toMatchObject(native);
});
