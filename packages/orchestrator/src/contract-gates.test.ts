import { ProjectConfig } from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { resolveContractGates } from "./contract-gates.js";

describe("contract gate resolution", () => {
  it("omits versioned project gates from readonly contracts", () => {
    const command = {
      program: "sh",
      args: ["-c", "printf ran > gate-ran.txt"],
      envAllowlist: [],
    };
    const config = ProjectConfig.parse({ tests: { commands: [command] } });

    expect(
      resolveContractGates({
        repoRoot: "/project",
        effectiveAccess: "readonly",
        config,
        trustGrants: [],
        operatorCommands: [],
        projectCommands: config.tests.commands,
      }),
    ).toEqual({ commands: [], autoProtectedPaths: [] });
  });
});
