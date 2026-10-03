import { formatRunResult } from "./run-result-format.js";
import type { McpTool, RunnerFn } from "./index.js";

export function accountsTool(runner: RunnerFn, outputSchema: Record<string, unknown>): McpTool {
  return {
    name: "claudexor_accounts",
    description:
      "Return the read-only Accounts view: registered profiles, readiness, quota freshness, and routing identity. " +
      "Default reads the server's CACHED listing (cheap; at most ~15s stale). " +
      "fresh:true requests the atomic snapshot instead — an EXPENSIVE explicit refresh (a live probe per registered profile, a full harness doctor sweep, and the vendor quota fan-out, which honors per-vendor rate-limit cooldowns and discloses skipped vendors in quota.refresh_skipped). " +
      "Use fresh:true only when acting on staleness matters; never poll with it. This tool never starts login or changes account state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fresh: {
          type: "boolean",
          description:
            "true = the expensive atomic Accounts snapshot (fresh probes + doctor + vendor quota fan-out); false/absent = the cached listing.",
        },
      },
    },
    outputSchema,
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const result = await runner({
        mode: "__accounts",
        ...(args?.fresh === true ? { fresh: true } : {}),
      });
      return {
        text: formatRunResult(result),
        structured: (result && typeof result === "object" ? result : {}) as Record<string, unknown>,
      };
    },
  };
}
