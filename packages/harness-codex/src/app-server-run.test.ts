import type { SpawnOptions, spawnProcess } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codexAppServerInput } from "./attachments.js";
import {
  CodexAppServerController,
  codexAppServerEvents,
  codexAppServerThreadParams,
  runCodexAppServer,
} from "./app-server-run.js";
import type { CodexParseState } from "./parse.js";
import { createCodexAdapter } from "./index.js";

describe("Codex app-server transport", () => {
  it("initializes, starts a thread and turn, and exposes the native thread id", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stopped = false;

    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, args, options: SpawnOptions = {}) {
      expect(args).toEqual(["app-server", "--stdio"]);
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as {
            id?: number;
            method: string;
            params?: Record<string, unknown> | null;
          };
          writes.push(request);
          if (request.method === "initialize") {
            push({ id: request.id, result: {} });
          } else if (request.method === "thread/start") {
            push({ id: request.id, result: { thread: { id: "thread-1" } } });
          } else if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-1" } } });
            push({
              method: "turn/started",
              params: { threadId: "thread-1", turn: { id: "turn-1" } },
            });
          }
        },
        end() {
          stopped = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      try {
        while (!stopped) {
          if (replies.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          yield { type: "stdout", line: replies.shift()! };
        }
      } finally {
        stopped = true;
      }
    };

    const spec = HarnessRunSpec.parse({
      session_id: "session-1",
      intent: "implement",
      prompt: "Keep working",
      cwd: process.cwd(),
    });
    let first: HarnessEvent | undefined;
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn,
    })) {
      first = event;
      break;
    }

    expect(writes.map((request) => request.id).filter(Boolean)).toEqual([1, 2, 3]);
    expect(writes.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(writes[0]?.params).toMatchObject({
      clientInfo: { name: "claudexor" },
      capabilities: { experimentalApi: true },
    });
    expect(first).toMatchObject({
      type: "started",
      session_id: "session-1",
      payload: { native_session_id: "thread-1", native_turn_id: "turn-1" },
    });
  });

  it("preserves run settings and verified image input", () => {
    const imagePath = fileURLToPath(import.meta.url);
    const imageBytes = readFileSync(imagePath);
    const spec = HarnessRunSpec.parse({
      session_id: "session-parity",
      intent: "implement",
      prompt: "Inspect it",
      instructions: "Stay terse",
      cwd: process.cwd(),
      access: "readonly",
      model_hint: "gpt-test",
      effort_hint: "high",
      external_context_policy: "off",
      output_schema: { type: "object" },
      attachments: [
        {
          resource_id: "image-1",
          kind: "image",
          mime: "image/png",
          name: "image.png",
          path: imagePath,
          sha256: `sha256:${createHash("sha256").update(imageBytes).digest("hex")}`,
          size_bytes: imageBytes.length,
        },
      ],
      extra_mcp_servers: [
        {
          name: "claudexor",
          command: "/bin/echo",
          args: ["server"],
          env: { RUN_ID: "run-1" },
          required: true,
        },
      ],
    });

    expect(codexAppServerThreadParams(spec)).toMatchObject({
      cwd: process.cwd(),
      model: "gpt-test",
      sandbox: "read-only",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      developerInstructions: "Stay terse",
      config: {
        web_search: "disabled",
        model_reasoning_effort: "high",
        mcp_servers: {
          claudexor: {
            command: "/bin/echo",
            args: ["server"],
            env: { RUN_ID: "run-1" },
            required: true,
          },
        },
      },
    });
    expect(codexAppServerInput(spec)).toEqual([
      { type: "text", text: "Inspect it" },
      { type: "localImage", path: imagePath },
    ]);
  });

  it("maps app-server item, plan, and usage notifications to existing events", () => {
    const state: CodexParseState = {};
    expect(
      codexAppServerEvents(
        {
          method: "item/started",
          params: {
            item: {
              type: "commandExecution",
              id: "cmd-1",
              command: "sleep 10",
              status: "inProgress",
            },
          },
        },
        "session-map",
        state,
      ),
    ).toMatchObject([{ type: "tool_call", tool: { use_id: "cmd-1" } }]);
    expect(
      codexAppServerEvents(
        {
          method: "turn/plan/updated",
          params: { plan: [{ step: "Wait", status: "inProgress" }] },
        },
        "session-map",
        state,
      )?.[0]?.plan_progress,
    ).toEqual({ items: [{ id: "codex-0", title: "Wait", status: "in_progress" }] });
    expect(
      codexAppServerEvents(
        {
          method: "thread/tokenUsage/updated",
          params: {
            tokenUsage: {
              last: {
                inputTokens: 11,
                cachedInputTokens: 3,
                cacheWriteInputTokens: 2,
                outputTokens: 5,
              },
            },
          },
        },
        "session-map",
        state,
      ),
    ).toMatchObject([
      {
        type: "usage",
        usage: {
          input_tokens: 11,
          cached_input_tokens: 3,
          output_tokens: 5,
          input_token_usage: {
            total_tokens: 11,
            cache_read_tokens: 3,
            cache_write_tokens: 2,
          },
        },
      },
    ]);
  });

  it("keeps one run active across a goal continuation and owned background terminal", async () => {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let snapshot = 0;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-bg" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-1" } } });
            push({
              method: "turn/started",
              params: { threadId: "thread-bg", turn: { id: "turn-1" } },
            });
            push({
              method: "item/completed",
              params: {
                item: { type: "agentMessage", id: "msg-1", text: "intermediate" },
              },
            });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-owned",
                  command: "sleep 10",
                  status: "inProgress",
                },
              },
            });
            push({
              method: "turn/completed",
              params: {
                threadId: "thread-bg",
                turn: { id: "turn-1", status: "completed", items: [] },
              },
            });
          }
          if (request.method === "thread/goal/get") {
            push({
              id: request.id,
              result: { goal: { status: snapshot === 0 ? "active" : "complete" } },
            });
          }
          if (request.method === "thread/read") {
            push({
              id: request.id,
              result: {
                thread: { status: { type: snapshot === 0 ? "active" : "idle" } },
              },
            });
          }
          if (request.method === "thread/backgroundTerminals/list") {
            push({
              id: request.id,
              result: {
                data: snapshot++ === 0 ? [{ itemId: "cmd-owned", processId: "process-1" }] : [],
              },
            });
            if (snapshot === 1) {
              push({
                method: "turn/started",
                params: { threadId: "thread-bg", turn: { id: "turn-2" } },
              });
              push({
                method: "item/completed",
                params: { item: { type: "agentMessage", id: "msg-2", text: "final" } },
              });
              push({
                method: "turn/completed",
                params: {
                  threadId: "thread-bg",
                  turn: { id: "turn-2", status: "completed", items: [] },
                },
              });
            } else {
              stop = true;
              wake?.();
            }
          }
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      while (!stop || replies.length) {
        if (replies.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        } else {
          yield { type: "stdout", line: replies.shift()! };
        }
      }
    };
    const spec = HarnessRunSpec.parse({
      session_id: "session-bg",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn,
      pollIntervalMs: 0,
    }))
      events.push(event);

    expect(events.filter((event) => event.type === "started")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message", text: "intermediate" }),
    );
    expect(events.find((event) => event.text === "intermediate")?.final).toBeUndefined();
    expect(events.filter((event) => event.final)).toEqual([
      expect.objectContaining({ type: "message", text: "final", final: true }),
    ]);
    expect(events.at(-1)?.type).toBe("completed");
    expect(events.at(-1)?.aborted).toBeUndefined();
  });

  it("does not complete while a run-owned background terminal is still present", async () => {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let snapshots = 0;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-wait" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-wait" } } });
            push({
              method: "turn/started",
              params: { turn: { id: "turn-wait" } },
            });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-wait",
                  command: "sleep 10",
                  status: "inProgress",
                },
              },
            });
            push({
              method: "item/completed",
              params: { item: { type: "agentMessage", id: "msg-wait", text: "done" } },
            });
            push({
              method: "turn/completed",
              params: { turn: { id: "turn-wait", status: "completed", items: [] } },
            });
          }
          if (request.method === "thread/read")
            push({
              id: request.id,
              result: { thread: { status: { type: snapshots ? "idle" : "active" } } },
            });
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: { status: "complete" } } });
          if (request.method === "thread/backgroundTerminals/list") {
            push({
              id: request.id,
              result: {
                data: snapshots++
                  ? [{ itemId: "unrelated", processId: "process-unrelated" }]
                  : [
                      { itemId: "cmd-wait", processId: "process-wait" },
                      { itemId: "unrelated", processId: "process-unrelated" },
                    ],
              },
            });
            if (snapshots === 2) {
              stop = true;
              wake?.();
            }
          }
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const spec = HarnessRunSpec.parse({
      session_id: "session-wait",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn,
      pollIntervalMs: 0,
    }))
      events.push(event);

    expect(snapshots).toBe(2);
    expect(events.filter((event) => event.final)).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("Stop pauses the goal, interrupts the exact turn, and terminates only owned terminals", async () => {
    const writes: Array<{ id?: number; method: string; params?: Record<string, unknown> }> = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let paused = false;
    let interrupted = false;
    let terminated = false;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as (typeof writes)[number];
          writes.push(request);
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-stop" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-stop" } } });
            push({
              method: "turn/started",
              params: { turn: { id: "turn-stop" } },
            });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-stop",
                  command: "sleep 60",
                  status: "inProgress",
                },
              },
            });
          }
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: { status: paused ? "paused" : "active" } } });
          if (request.method === "thread/goal/set") {
            paused = true;
            push({ id: request.id, result: { goal: { status: "paused" } } });
          }
          if (request.method === "turn/interrupt") {
            interrupted = true;
            push({ id: request.id, result: {} });
            push({
              method: "turn/completed",
              params: { turn: { id: "turn-stop", status: "interrupted", items: [] } },
            });
          }
          if (request.method === "thread/backgroundTerminals/list")
            push({
              id: request.id,
              result: {
                data: [
                  ...(terminated ? [] : [{ itemId: "cmd-stop", processId: "process-owned" }]),
                  { itemId: "other", processId: "process-unrelated" },
                ],
              },
            });
          if (request.method === "thread/backgroundTerminals/terminate") {
            terminated = true;
            push({ id: request.id, result: {} });
          }
          if (request.method === "thread/read")
            push({
              id: request.id,
              result: {
                thread: { status: { type: interrupted && terminated ? "idle" : "active" } },
              },
            });
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const spec = HarnessRunSpec.parse({
      session_id: "session-stop",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const controller = new CodexAppServerController();
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn,
      controller,
      pollIntervalMs: 0,
      cancelDeadlineMs: 100,
    })) {
      events.push(event);
      if (event.type === "tool_call") await Promise.all([controller.cancel(), controller.cancel()]);
    }

    expect(writes.filter((request) => request.method === "thread/goal/set")).toHaveLength(1);
    expect(writes.filter((request) => request.method === "turn/interrupt")).toEqual([
      expect.objectContaining({ params: { threadId: "thread-stop", turnId: "turn-stop" } }),
    ]);
    expect(
      writes.filter((request) => request.method === "thread/backgroundTerminals/terminate"),
    ).toEqual([
      expect.objectContaining({
        params: { threadId: "thread-stop", processId: "process-owned" },
      }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "completed", aborted: true });
  });

  it("Stop pauses a goal between continuation turns without guessing a turn id", async () => {
    const methods: string[] = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let paused = false;
    let resolveGap!: () => void;
    const gap = new Promise<void>((resolve) => {
      resolveGap = resolve;
    });
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          methods.push(request.method);
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-gap" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-gap" } } });
            push({ method: "turn/started", params: { turn: { id: "turn-gap" } } });
            push({
              method: "turn/completed",
              params: { turn: { id: "turn-gap", status: "completed", items: [] } },
            });
          }
          if (request.method === "thread/read")
            push({
              id: request.id,
              result: { thread: { status: { type: paused ? "idle" : "active" } } },
            });
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: { status: paused ? "paused" : "active" } } });
          if (request.method === "thread/goal/set") {
            paused = true;
            push({ id: request.id, result: { goal: { status: "paused" } } });
          }
          if (request.method === "thread/backgroundTerminals/list") {
            push({ id: request.id, result: { data: [] } });
            if (!paused) resolveGap();
          }
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const controller = new CodexAppServerController();
    const spec = HarnessRunSpec.parse({
      session_id: "session-gap",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    const collect = (async () => {
      for await (const event of runCodexAppServer({
        bin: "codex",
        args: [],
        spec,
        env: {},
        spawn,
        controller,
        pollIntervalMs: 0,
        cancelDeadlineMs: 100,
      }))
        events.push(event);
    })();
    await gap;
    await controller.cancel();
    await collect;

    expect(methods.filter((method) => method === "thread/goal/set")).toHaveLength(1);
    expect(methods).not.toContain("turn/interrupt");
    expect(events.at(-1)).toMatchObject({ type: "completed", aborted: true });
  });

  it("fails closed when native interrupt acknowledgement misses the deadline", async () => {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-timeout" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-timeout" } } });
            push({ method: "turn/started", params: { turn: { id: "turn-timeout" } } });
          }
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: null } });
          // Deliberately never answer turn/interrupt.
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const controller = new CodexAppServerController();
    const spec = HarnessRunSpec.parse({
      session_id: "session-timeout",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn,
      controller,
      cancelDeadlineMs: 1,
    })) {
      events.push(event);
      if (event.type === "started") await controller.cancel();
    }

    expect(events.find((event) => event.type === "error")?.payload?.["code"]).toBe(
      "codex_control_loss",
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      aborted: true,
      payload: { code: "codex_control_loss" },
    });
  });

  it("routes adapter runs and Stop through the matching app-server controller", async () => {
    let appServerRuns = 0;
    let execRuns = 0;
    let cancels = 0;
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex-cli 0.156.1",
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () => null,
      runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {
        execRuns++;
        throw new Error("legacy exec path must not run");
      },
      runAppServer: async function* (input): AsyncGenerator<HarnessEvent> {
        appServerRuns++;
        input.controller?.bind(async () => {
          cancels++;
          release();
        });
        yield {
          type: "started",
          session_id: input.spec.session_id,
          ts: "2026-09-24T00:00:00.000Z",
          payload: { native_session_id: "native-1" },
        };
        await stopped;
        yield {
          type: "completed",
          session_id: input.spec.session_id,
          ts: "2026-09-24T00:00:01.000Z",
          aborted: true,
        };
      },
    });
    const spec = HarnessRunSpec.parse({
      session_id: "session-adapter",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const iterator = adapter.run(spec)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "started" });
    await adapter.cancel?.("session-adapter");
    expect((await iterator.next()).value).toMatchObject({ type: "completed", aborted: true });
    expect((await iterator.next()).done).toBe(true);
    await adapter.cancel?.("session-adapter");
    expect(appServerRuns).toBe(1);
    expect(execRuns).toBe(0);
    expect(cancels).toBe(1);
  });
});
