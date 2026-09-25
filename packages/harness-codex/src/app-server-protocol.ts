import { browserMcpCommand } from "@claudexor/core";
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { CODEX_EFFORT_SNAPSHOT, codexEffortFor, type CodexEffortCatalog } from "./effort-probe.js";
import { parseCodexEvent, type CodexParseState } from "./parse.js";

export type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function sandboxMode(access: HarnessRunSpec["access"]): string | null {
  if (access === "readonly") return "read-only";
  if (access === "workspace_write") return "workspace-write";
  if (access === "full") return "danger-full-access";
  return null;
}

export function codexAppServerThreadParams(
  spec: HarnessRunSpec,
  effortCatalog: CodexEffortCatalog = CODEX_EFFORT_SNAPSHOT,
): JsonObject {
  const mcpServers: Record<string, JsonObject> = {};
  if (spec.browser && spec.external_context_policy !== "off") {
    const browser = browserMcpCommand(spec.browser);
    mcpServers["browser"] = {
      command: browser.command,
      args: browser.args,
      startup_timeout_sec: 90,
      tool_timeout_sec: 120,
    };
  }
  for (const server of spec.extra_mcp_servers) {
    mcpServers[server.name] = {
      command: server.command,
      args: server.args,
      env: server.env,
      required: server.required,
      startup_timeout_sec: 90,
      tool_timeout_sec: 120,
    };
  }
  const config: JsonObject = {
    web_search:
      spec.external_context_policy === "off"
        ? "disabled"
        : spec.external_context_policy === "live"
          ? "live"
          : "cached",
    project_doc_fallback_filenames: ["CLAUDE.md"],
    ...(Object.keys(mcpServers).length ? { mcp_servers: mcpServers } : {}),
  };
  const effort = codexEffortFor(effortCatalog, spec.model_hint, spec.effort_hint);
  if (effort) config["model_reasoning_effort"] = effort;
  if (spec.processing?.submittedNative) config["service_tier"] = spec.processing.submittedNative;
  const sandbox = sandboxMode(spec.access);
  return {
    cwd: spec.cwd,
    model: spec.model_hint,
    ...(sandbox ? { sandbox } : {}),
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    ...(spec.instructions?.trim() ? { developerInstructions: spec.instructions } : {}),
    config,
  };
}

function appServerItem(item: JsonObject): JsonObject {
  const type = item["type"];
  if (type === "agentMessage") return { ...item, type: "agent_message" };
  if (type === "commandExecution")
    return {
      ...item,
      type: "command_execution",
      aggregated_output: item["aggregatedOutput"],
      exit_code: item["exitCode"],
    };
  if (type === "fileChange")
    return {
      ...item,
      type: "file_change",
      path: Array.isArray(item["changes"]) ? asObject(item["changes"][0])?.["path"] : undefined,
    };
  if (type === "mcpToolCall") return { ...item, type: "mcp_tool_call" };
  if (type === "webSearch") return { ...item, type: "web_search" };
  if (type === "reasoning")
    return {
      ...item,
      text: [
        ...(Array.isArray(item["summary"]) ? item["summary"] : []),
        ...(Array.isArray(item["content"]) ? item["content"] : []),
      ].join("\n"),
    };
  return item;
}

/** Map official app-server notifications onto the adapter's existing event vocabulary. */
export function codexAppServerEvents(
  notification: JsonObject,
  sessionId: string,
  state: CodexParseState,
): HarnessEvent[] | null {
  const method = notification["method"];
  const params = asObject(notification["params"]);
  if (!params) return null;
  if (method === "item/started" || method === "item/completed") {
    const item = asObject(params["item"]);
    if (!item) return null;
    return parseCodexEvent(
      {
        type: method === "item/started" ? "item.started" : "item.completed",
        item: appServerItem(item),
      },
      sessionId,
      state,
    );
  }
  if (method === "turn/plan/updated") {
    const plan = Array.isArray(params["plan"]) ? params["plan"] : [];
    const items = plan.map((raw, index) => {
      const step = asObject(raw);
      return {
        id: `codex-${index}`,
        title: String(step?.["step"] ?? ""),
        status:
          step?.["status"] === "completed"
            ? ("completed" as const)
            : step?.["status"] === "inProgress"
              ? ("in_progress" as const)
              : ("pending" as const),
      };
    });
    const key = JSON.stringify(items);
    if (state.lastPlanProgressKey === key) return [];
    state.lastPlanProgressKey = key;
    return [
      {
        type: "message",
        session_id: sessionId,
        ts: nowIso(),
        text: items.length
          ? `Plan:\n${items.map((item) => `${item.status === "completed" ? "[x]" : "[ ]"} ${item.title}`).join("\n")}`
          : "Plan updated",
        plan_progress: { items },
      },
    ];
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = asObject(asObject(params["tokenUsage"])?.["last"]);
    if (!usage) return null;
    const number = (key: string): number | undefined =>
      typeof usage[key] === "number" ? usage[key] : undefined;
    return [
      {
        type: "usage",
        session_id: sessionId,
        ts: nowIso(),
        usage: {
          input_tokens: number("inputTokens"),
          output_tokens: number("outputTokens"),
          cached_input_tokens: number("cachedInputTokens"),
          input_token_usage: {
            total_tokens: number("inputTokens") ?? null,
            cache_read_tokens: number("cachedInputTokens") ?? null,
            cache_write_tokens: number("cacheWriteInputTokens") ?? null,
          },
        },
      },
    ];
  }
  return null;
}
