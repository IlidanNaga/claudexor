import { spawnProcess, type ChildStdin, type SpawnOptions } from "@claudexor/core";
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { codexAppServerInput } from "./attachments.js";
import type { CodexEffortCatalog } from "./effort-probe.js";
import {
  codexAppServerEvents,
  codexAppServerThreadParams,
  type JsonObject,
} from "./app-server-protocol.js";
import { parseCodexEvent, type CodexParseState } from "./parse.js";

export { codexAppServerEvents, codexAppServerThreadParams } from "./app-server-protocol.js";

export interface CodexAppServerRunInput {
  bin: string;
  args: string[];
  spec: HarnessRunSpec;
  env: Record<string, string | null | undefined>;
  spawn?: typeof spawnProcess;
  controller?: CodexAppServerController;
  effortCatalog?: CodexEffortCatalog;
  /** Test seam; production polls owned background terminals four times per second. */
  pollIntervalMs?: number;
  /** Test seam for the bounded cooperative-stop deadline. */
  cancelDeadlineMs?: number;
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
  let processStopped = false;
  let nativeThreadId: string | null = null;
  let activeTurnId: string | null = null;
  const ownedCommandItemIds = new Set<string>();
  let cancellationRequested = false;
  let cancellationQuiescent = false;
  let cancellationFailure: Error | null = null;

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
      throw processFailure;
    } finally {
      processStopped = true;
      if (abort.signal.aborted)
        rejectPending(cancellationFailure ?? new Error("Codex app-server stopped"));
      notificationWaiter.wake?.();
      notificationWaiter.wake = undefined;
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
      if (processStopped) throw cancellationFailure ?? new Error("Codex app-server disconnected");
      await new Promise<void>((resolve) => {
        notificationWaiter.wake = resolve;
      });
    }
  };
  const stopProcess = async (): Promise<void> => {
    if (abort.signal.aborted) return;
    abort.abort();
    io?.end();
    await process.catch(() => {});
  };
  const backgroundTerminals = async (): Promise<JsonObject[]> => {
    if (!nativeThreadId) return [];
    const result = await request("thread/backgroundTerminals/list", {
      threadId: nativeThreadId,
    });
    return Array.isArray(result["data"])
      ? result["data"].map(asObject).filter((item): item is JsonObject => item !== null)
      : [];
  };
  const readLifecycle = async (): Promise<{
    threadIdle: boolean;
    goalActive: boolean;
    ownedBackground: JsonObject[];
  }> => {
    if (!nativeThreadId) return { threadIdle: false, goalActive: false, ownedBackground: [] };
    const [threadResult, goalResult, terminals] = await Promise.all([
      request("thread/read", { threadId: nativeThreadId, includeTurns: false }),
      request("thread/goal/get", { threadId: nativeThreadId }),
      backgroundTerminals(),
    ]);
    const status = asObject(asObject(threadResult["thread"])?.["status"]);
    const goal = asObject(goalResult["goal"]);
    return {
      threadIdle: status?.["type"] === "idle",
      goalActive: goal?.["status"] === "active",
      ownedBackground: terminals.filter(
        (terminal) =>
          typeof terminal["itemId"] === "string" && ownedCommandItemIds.has(terminal["itemId"]),
      ),
    };
  };
  let cancelPromise: Promise<void> | null = null;
  const cancel = (): Promise<void> => {
    if (cancelPromise) return cancelPromise;
    cancellationRequested = true;
    cancelPromise = (async () => {
      try {
        const cooperative = async (): Promise<void> => {
          await spawned;
          if (!nativeThreadId) return;
          const goalResult = await request("thread/goal/get", { threadId: nativeThreadId });
          if (asObject(goalResult["goal"])?.["status"] === "active")
            await request("thread/goal/set", { threadId: nativeThreadId, status: "paused" });
          const turnId = activeTurnId;
          if (turnId) await request("turn/interrupt", { threadId: nativeThreadId, turnId });
          for (const terminal of await backgroundTerminals()) {
            if (
              typeof terminal["itemId"] === "string" &&
              ownedCommandItemIds.has(terminal["itemId"]) &&
              typeof terminal["processId"] === "string"
            )
              await request("thread/backgroundTerminals/terminate", {
                threadId: nativeThreadId,
                processId: terminal["processId"],
              });
          }
          for (;;) {
            const lifecycle = await readLifecycle();
            if (
              lifecycle.threadIdle &&
              !lifecycle.goalActive &&
              lifecycle.ownedBackground.length === 0
            ) {
              cancellationQuiescent = true;
              return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, input.pollIntervalMs ?? 250));
          }
        };
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            cooperative(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("Codex cooperative cancellation was not acknowledged")),
                input.cancelDeadlineMs ?? 5_000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (error) {
        cancellationFailure = error instanceof Error ? error : new Error(String(error));
      } finally {
        await stopProcess();
      }
    })();
    return cancelPromise;
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
        ? {
            ...codexAppServerThreadParams(input.spec, input.effortCatalog),
            threadId: input.spec.resume_session_id,
          }
        : codexAppServerThreadParams(input.spec, input.effortCatalog),
    );
    const thread = asObject(threadResult["thread"]);
    const threadId = thread?.["id"];
    if (typeof threadId !== "string") throw new Error("Codex app-server omitted thread id");
    nativeThreadId = threadId;
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
    activeTurnId = turnId;
    let pendingTerminal: JsonObject | null = null;
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
      if (method === "turn/completed") {
        pendingTerminal = asObject(params?.["turn"]);
        activeTurnId = null;
      } else if (!pendingTerminal) {
        continue;
      }

      for (;;) {
        const current =
          cancellationRequested && cancellationQuiescent
            ? { threadIdle: true, goalActive: false, ownedBackground: [] }
            : await readLifecycle();
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
    if (cancellationRequested && cancellationQuiescent) {
      yield {
        type: "completed",
        session_id: input.spec.session_id,
        ts: nowIso(),
        aborted: true,
        payload: { code: "user_cancelled", native_session_id: nativeThreadId },
      };
      return;
    }
    const aborted = abort.signal.aborted;
    yield {
      type: "error",
      session_id: input.spec.session_id,
      ts: nowIso(),
      error: redactSecrets(errorText(error)),
      payload: {
        code: cancellationFailure ? "codex_control_loss" : "codex_app_server_failure",
      },
    };
    yield {
      type: "completed",
      session_id: input.spec.session_id,
      ts: nowIso(),
      ...(aborted ? { aborted: true } : {}),
      payload: {
        code: cancellationFailure
          ? "codex_control_loss"
          : aborted
            ? "user_cancelled"
            : "codex_app_server_failure",
      },
    };
  } finally {
    if (externalAbort instanceof AbortSignal) externalAbort.removeEventListener("abort", onAbort);
    input.controller?.clear(cancel);
    await stopProcess();
  }
}
