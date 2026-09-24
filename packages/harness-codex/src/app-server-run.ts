import {
  spawnProcess,
  type ChildStdin,
  type SpawnOptions,
} from "@claudexor/core";
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { CLAUDEXOR_VERSION, nowIso } from "@claudexor/util";

type JsonObject = Record<string, unknown>;

export interface CodexAppServerRunInput {
  bin: string;
  args: string[];
  spec: HarnessRunSpec;
  env: Record<string, string | null | undefined>;
  spawn?: typeof spawnProcess;
  controller?: CodexAppServerController;
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
        : { cwd: input.spec.cwd, model: input.spec.model_hint },
    );
    const thread = asObject(threadResult["thread"]);
    const threadId = thread?.["id"];
    if (typeof threadId !== "string") throw new Error("Codex app-server omitted thread id");
    await request("turn/start", {
      threadId,
      input: [{ type: "text", text: input.spec.prompt }],
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
    await process;
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
