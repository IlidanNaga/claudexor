import { afterEach, describe, expect, it, vi } from "vitest";
import * as daemonRun from "./daemon-run.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import { parseArgs } from "./args.js";
import { commandFlagScopeError } from "./command-scope.js";
import { parseReviewerPanelJson } from "./reviewer-options.js";

afterEach(() => vi.restoreAllMocks());
const connection = {
  client: {},
  addr: { baseUrl: "http://localhost:1", token: "fixture" },
  engine: {},
} as never;

describe("public run request propagation", () => {
  it("registers discard as a decision-only action flag", () => {
    expect(commandFlagScopeError("decision", ["discard"])).toBeNull();
    expect(commandFlagScopeError("ask", ["discard"])).not.toBeNull();
    expect(parseArgs(["decision", "run", "--discard"]).flags.discard).toBe(true);
  });
  it("MCP retains explicit Standard, reviewer exceptions and directory selection", async () => {
    vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue(connection);
    const enqueue = vi
      .spyOn(daemonRun, "enqueueAndAwait")
      .mockResolvedValue({ runId: "child", jobId: "job", status: "running", runDir: "/run" });
    const execution = { workspaceKind: "directory", scopePaths: ["assets", "binary.dat"] };
    const reviewerPanel = parseReviewerPanelJson(
      '[{"harness":"claude","processingPreference":"economy"}]',
    );
    await mcpSurfaceRunner()({
      mode: "agent",
      prompt: "work",
      deferred: true,
      processingPreference: "standard",
      execution,
      reviewerPanel,
    });
    expect(enqueue.mock.calls[0]?.[2]).toMatchObject({
      processingPreference: "standard",
      reviewerPanel,
      execution: { ...execution, isolation: "envelope" },
    });
  });
  it("belt transport uses its captured policy and lineage over raw child arguments", async () => {
    vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue(connection);
    const enqueue = vi
      .spyOn(daemonRun, "enqueueAndAwait")
      .mockResolvedValue({ runId: "child", jobId: "job", status: "running", runDir: "/run" });
    await mcpSurfaceRunner({
      requireExistingDaemon: true,
      delegationParentRunId: "parent",
      delegationRepoRoot: "/source",
      delegationProcessingPreference: "standard",
      delegationExecution: { workspaceKind: "directory", scopePaths: ["selected"] },
    })({
      mode: "agent",
      prompt: "child",
      deferred: true,
      processingPreference: "fast",
      repoPath: "/other",
      execution: { isolation: "live", workspaceRoot: "/wrong", scopePaths: ["."] },
    });
    expect(enqueue.mock.calls[0]?.[2]).toMatchObject({
      processingPreference: "standard",
      parentRunId: "parent",
      delegatedFromRunId: "parent",
      scope: { root: "/source" },
      execution: { isolation: "envelope", workspaceKind: "directory", scopePaths: ["selected"] },
    });
    expect((enqueue.mock.calls[0]?.[2] as any).execution).not.toHaveProperty("workspaceRoot");
  });
});
