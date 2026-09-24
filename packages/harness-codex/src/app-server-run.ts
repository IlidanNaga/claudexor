import {
  browserMcpCommand,
  spawnProcess,
  type ChildStdin,
  type SpawnOptions,
} from "@claudexor/core";
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { CLAUDEXOR_VERSION, nowIso } from "@claudexor/util";
import { codexAppServerInput } from "./attachments.js";
import { CODEX_EFFORT_SNAPSHOT, codexEffortFor, type CodexEffortCatalog } from "./effort-probe.js";
import { parseCodexEvent, type CodexParseState } from "./parse.js";

type JsonObject = Record<string, unknown>;

export interface CodexAppServerRunInput {
  bin: string;
  args: string[];
  spec: HarnessRunSpec;
  env: Record<string, string | null | undefined>;
  spawn?: typeof spawnProcess;
  controller?: CodexAppServerController;
  /** Test seam; production polls owned background terminals four times per second. */
  pollIntervalMs?: number;
}

export class CodexAppServerController {
  private cancelRun: (() => Promise<void>) | null = null;

  bind(cancel: () => Promise<void>): void {
    this.cancelRun = cancel;
  }

  clear(cancel: () => Promise<void>): void {
    if (this.cancelRun === cancel) this.cancelRun = null;
  }

  async cancel(): Promise<void> {
    await this.cancelRun?.();
  }
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export async function* runCodexAppServer(
  input: CodexAppServerRunInput,
): AsyncGenerator<HarnessEvent> {
  const run = input.spawn ?? spawnProcess;
  const abort = new AbortController();
  const pending = new Map<
    number,
    { resolve: (value: JsonObject) => void; reject: (error: Error) => void }
  >();
  const notifications: JsonObject[] = [];
  const notificationWaiter: { wake?: () => void } = {};
  let io: ChildStdin | null = null;
  let resolveSpawn!: () => void;
  const spawned = new Promise<void>((resolve) => {
    resolveSpawn = resolve;
  });
  let nextId = 1;
  let processFailure: Error | null = null;

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const onMessage = (message: unknown): void => {
    const object = asObject(message);
    if (!object) throw new Error("Codex app-server sent a non-object JSON-RPC frame");
    if (typeof object["id"] === "number") {
      const request = pending.get(object["id"]);
      if (!request) return;
      pending.delete(object["id"]);
      const rpcError = asObject(object["error"]);
      if (rpcError) {
        request.reject(new Error(String(rpcError["message"] ?? "Codex app-server request failed")));
        return;
      }
      const result = asObject(object["result"]);
      if (!result) {
        request.reject(new Error("Codex app-server returned a malformed JSON-RPC result"));
        return;
      }
      request.resolve(result);
      return;
    }
    if (typeof object["method"] === "string") {
      notifications.push(object);
      notificationWaiter.wake?.();
      notificationWaiter.wake = undefined;
    }
  };

  const process = (async (): Promise<void> => {
    try {
      const options: SpawnOptions = {
        cwd: input.spec.cwd,
        env: input.env,
        inheritEnv: input.spec.env_inheritance,
        keepStdinOpen: true,
        abortSignal: abort.signal,
        onSpawn(childIo) {
          io = childIo;
          resolveSpawn();
        },
      };
      for await (const event of run(input.bin, [...input.args, "app-server", "--stdio"], options)) {
        if (event.type === "stdout") {
          try {
            onMessage(JSON.parse(event.line));
          } catch (error) {
            throw new Error(`Invalid Codex app-server frame: ${errorText(error)}`);
          }
        } else if (event.type === "termination_unconfirmed") {
          throw new Error("Codex app-server process termination could not be confirmed");
        } else if (event.type === "exit" && !abort.signal.aborted) {
          throw new Error(
            `Codex app-server exited before the run completed (code ${event.code ?? "null"})`,
          );
        }
      }
    } catch (error) {
      processFailure = error instanceof Error ? error : new Error(String(error));
      rejectPending(processFailure);
      notificationWaiter.wake?.();
      notificationWaiter.wake = undefined;
      throw processFailure;
    }
  })();
  void process.catch(() => {});

  const request = async (method: string, params: JsonObject): Promise<JsonObject> => {
    await Promise.race([
      spawned,
      process.then(() => {
        throw processFailure ?? new Error("Codex app-server exited before accepting requests");
      }),
    ]);
    const id = nextId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    io!.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  };
  const notify = async (method: string, params: JsonObject | null): Promise<void> => {
    await spawned;
    io!.write(`${JSON.stringify({ method, params })}\n`);
  };
  const nextNotification = async (method: string): Promise<JsonObject> => {
    for (;;) {
      const index = notifications.findIndex((item) => item["method"] === method);
      if (index >= 0) return notifications.splice(index, 1)[0]!;
      if (processFailure) throw processFailure;
      await new Promise<void>((resolve) => {
        notificationWaiter.wake = resolve;
      });
    }
  };
  const takeNotification = async (): Promise<JsonObject> => {
    for (;;) {
      const next = notifications.shift();
      if (next) return next;
      if (processFailure) throw processFailure;
      await new Promise<void>((resolve) => {
        notificationWaiter.wake = resolve;
      });
    }
  };
  const cancel = async (): Promise<void> => {
    if (abort.signal.aborted) return;
    abort.abort();
    io?.end();
    await process.catch(() => {});
  };
  input.controller?.bind(cancel);
  const onAbort = (): void => void cancel();
  const externalAbort = input.spec.extra["abortSignal"];
  if (externalAbort instanceof AbortSignal) {
    if (externalAbort.aborted) onAbort();
    else externalAbort.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await request("initialize", {
      clientInfo: { name: "claudexor", version: CLAUDEXOR_VERSION },
      capabilities: { experimentalApi: true },
    });
    await notify("initialized", null);
    const threadResult = await request(
      input.spec.resume_session_id ? "thread/resume" : "thread/start",
      input.spec.resume_session_id
        ? { threadId: input.spec.resume_session_id }
        : codexAppServerThreadParams(input.spec),
    );
    const thread = asObject(threadResult["thread"]);
    const threadId = thread?.["id"];
    if (typeof threadId !== "string") throw new Error("Codex app-server omitted thread id");
    await request("turn/start", {
      threadId,
      input: codexAppServerInput(input.spec),
      ...(input.spec.output_schema ? { outputSchema: input.spec.output_schema } : {}),
    });
    const started = await nextNotification("turn/started");
    const params = asObject(started["params"]);
    const turn = asObject(params?.["turn"]);
    const turnId = turn?.["id"];
    if (typeof turnId !== "string") throw new Error("Codex app-server omitted active turn id");
    yield {
      type: "started",
      session_id: input.spec.session_id,
      ts: nowIso(),
      payload: { native_session_id: threadId, native_turn_id: turnId },
    };
    const parseState: CodexParseState = {
      envelopeActive: !!input.spec.output_schema,
      requiredMcpServers: input.spec.extra_mcp_servers
        .filter((server) => server.required)
        .map((server) => server.name),
      startedEmitted: true,
    };
    const ownedCommandItemIds = new Set<string>();
    let activeTurnId: string | null = turnId;
    let pendingTerminal: JsonObject | null = null;
    const snapshot = async (): Promise<{
      threadIdle: boolean;
      goalActive: boolean;
      ownedBackground: JsonObject[];
    }> => {
      const [threadResult, goalResult, terminalResult] = await Promise.all([
        request("thread/read", { threadId, includeTurns: false }),
        request("thread/goal/get", { threadId }),
        request("thread/backgroundTerminals/list", { threadId }),
      ]);
      const status = asObject(asObject(threadResult["thread"])?.["status"]);
      const goal = asObject(goalResult["goal"]);
      const terminals = Array.isArray(terminalResult["data"])
        ? terminalResult["data"].map(asObject).filter((item): item is JsonObject => item !== null)
        : [];
      return {
        threadIdle: status?.["type"] === "idle",
        goalActive: goal?.["status"] === "active",
        ownedBackground: terminals.filter(
          (terminal) =>
            typeof terminal["itemId"] === "string" && ownedCommandItemIds.has(terminal["itemId"]),
        ),
      };
    };
    for (;;) {
      const notification = await takeNotification();
      const method = notification["method"];
      const params = asObject(notification["params"]);
      if (method === "turn/started") {
        const nextTurn = asObject(params?.["turn"]);
        if (typeof nextTurn?.["id"] === "string") activeTurnId = nextTurn["id"];
        pendingTerminal = null;
        parseState.lastAgentMessage = undefined;
        continue;
      }
      if (method === "item/started") {
        const item = asObject(params?.["item"]);
        if (item?.["type"] === "commandExecution" && typeof item["id"] === "string")
          ownedCommandItemIds.add(item["id"]);
      }
      const mapped = codexAppServerEvents(notification, input.spec.session_id, parseState);
      if (mapped) for (const event of mapped) yield event;
      if (method !== "turn/completed") continue;
      pendingTerminal = asObject(params?.["turn"]);
      activeTurnId = null;

      for (;;) {
        const current = await snapshot();
        if (notifications.some((item) => item["method"] === "turn/started")) break;
        if (!current.threadIdle || current.goalActive || current.ownedBackground.length) {
          if (current.ownedBackground.length && !current.goalActive) {
            await new Promise<void>((resolve) => setTimeout(resolve, input.pollIntervalMs ?? 250));
            continue;
          }
          break;
        }
        const status = pendingTerminal?.["status"];
        if (status === "failed") {
          const error = asObject(pendingTerminal?.["error"]);
          const failed = parseCodexEvent(
            { type: "turn.failed", error: { message: error?.["message"] ?? "turn failed" } },
            input.spec.session_id,
            parseState,
          );
          if (failed) for (const event of failed) yield event;
        } else if (status === "completed") {
          const final = parseCodexEvent(
            { type: "turn.completed", usage: {} },
            input.spec.session_id,
            parseState,
          );
          if (final)
            for (const event of final) {
              if (event.type !== "usage") yield event;
            }
        }
        yield {
          type: "completed",
          session_id: input.spec.session_id,
          ts: nowIso(),
          ...(status === "interrupted" ? { aborted: true } : {}),
          payload: {
            native_session_id: threadId,
            native_turn_id: pendingTerminal?.["id"] ?? activeTurnId,
          },
        };
        return;
      }
    }
  } catch (error) {
    const aborted = abort.signal.aborted;
    yield {
      type: "error",
      session_id: input.spec.session_id,
      ts: nowIso(),
      error: errorText(error),
      payload: { code: "codex_app_server_failure" },
    };
    yield {
      type: "completed",
      session_id: input.spec.session_id,
      ts: nowIso(),
      ...(aborted ? { aborted: true } : {}),
      payload: { code: aborted ? "user_cancelled" : "codex_app_server_failure" },
    };
  } finally {
    if (externalAbort instanceof AbortSignal) externalAbort.removeEventListener("abort", onAbort);
    input.controller?.clear(cancel);
    await cancel();
  }
}
