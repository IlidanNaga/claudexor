import type { CliCommandSpec } from "./command-registry.js";

export const REMOTE_COMMAND_SPECS = [
  {
    id: "remote",
    positionalPatterns: [
      // The handler's long-standing default action: `remote --json` is probe.
      { min: 0, max: 0 },
      { prefix: ["probe"], min: 1, max: 1 },
      { prefix: ["bootstrap"], min: 1, max: 1 },
      { prefix: ["stop"], min: 3, max: 3 },
      { prefix: ["activate"], min: 3, max: 3 },
      { prefix: ["rollback"], min: 3, max: 3 },
    ],
    usageArgs:
      "probe|bootstrap|stop <expectedVersion> <expectedBuildSha>|activate <expectedTarget|-> <nextTarget|->|rollback <expectedTarget|-> <nextTarget|-> --json",
    summary: "Internal SSH runtime bootstrap interface",
    flags: ["json"],
    mutability: "ops",
    stability: "experimental",
  },
  {
    id: "setup",
    positionalPatterns: [
      { prefix: ["attach"], min: 2, max: 2 },
      { prefix: ["cancel"], min: 2, max: 2 },
      { prefix: ["reconcile"], min: 2, max: 2 },
    ],
    usageArgs: "attach|cancel|reconcile <jobId>",
    summary: "Attach a terminal to a setup login, cancel it, or reconcile its termination",
    flags: ["json"],
    subcommandFlags: { attach: [], cancel: ["json"], reconcile: ["json"] },
    mutability: "ops",
    stability: "experimental",
  },
] as const satisfies readonly CliCommandSpec[];
