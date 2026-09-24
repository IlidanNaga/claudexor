import type { SpawnOptions, spawnProcess } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codexAppServerInput } from "./attachments.js";
import {
  codexAppServerEvents,
  codexAppServerThreadParams,
  runCodexAppServer,
} from "./app-server-run.js";
import type { CodexParseState } from "./parse.js";

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
});
