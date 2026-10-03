import { describe, expect, it } from "vitest";
import { HarnessModel } from "@claudexor/schema";
import { cursorProcessingModels, prepareCursorProcessing } from "./processing.js";
import { createCursorAdapter } from "./index.js";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";

const models = [
  "cursor-grok-4.6-xhigh",
  "cursor-grok-4.6-xhigh-fast",
  "cursor-grok-4.6-high-fast",
  "claude-fable-5-1-high",
].map((id) => HarnessModel.parse({ id }));

describe("Cursor processing uses listed same-effort variants", () => {
  it("dispatches prepared native variant without rewriting the requested cognitive model", async () => {
    let captured: CliRunLoopOptions | undefined;
    const prepared = prepareCursorProcessing("fast", "cursor-grok-4.6-xhigh", models);
    const adapter = createCursorAdapter({
      cursorApiKey: () => "fixture-key",
      smokeIsolatedApiKey: async () => ({ ok: true, detail: "fixture" }),
      listCursorModels: async () => {
        throw new Error("prepared dispatch must not rediscover");
      },
      runCliHarness: async function* (opts): AsyncGenerator<HarnessEvent> {
        captured = opts;
        yield { type: "completed", session_id: opts.spec.session_id, ts: "2026-09-12T00:00:00Z" };
      },
    });
    const spec = HarnessRunSpec.parse({
      session_id: "s",
      intent: "implement",
      prompt: "test",
      cwd: "/repo",
      access: "workspace_write",
      auth_preference: "api_key",
      model_hint: "cursor-grok-4.6-xhigh",
      effort_hint: "low", // Separate preference never rewrites the compound model id.
      processing: prepared.receipt,
      processing_cost_basis: prepared.costBasis,
    });
    for await (const _event of adapter.run(spec)) {
      /* consume */
    }
    expect(captured?.args[captured.args.indexOf("--model") + 1]).toBe("cursor-grok-4.6-xhigh-fast");
    expect(captured?.spec.model_hint).toBe("cursor-grok-4.6-xhigh");
  });
  it("honors no-paid policy on an existing Fast selection only through a real ordinary pair", () => {
    expect(
      prepareCursorProcessing(undefined, "cursor-grok-4.6-xhigh-fast", models, false),
    ).toMatchObject({
      model: "cursor-grok-4.6-xhigh",
      receipt: { requested: null, submitted: "standard" },
    });
    expect(
      prepareCursorProcessing(undefined, "cursor-grok-4.6-high-fast", models, false).model,
    ).toBe("cursor-grok-4.6-high-fast");
  });
  it("selects an actual pair and keeps billing and execution unknown", () => {
    expect(prepareCursorProcessing("fast", "cursor-grok-4.6-xhigh", models)).toMatchObject({
      model: "cursor-grok-4.6-xhigh-fast",
      receipt: { submitted: "fast", observed: "unknown" },
      costBasis: { kind: "unknown" },
    });
  });
  it("does not invent a suffix or borrow another effort's variant", () => {
    expect(prepareCursorProcessing("fast", "claude-fable-5-1-high", models).model).toBe(
      "claude-fable-5-1-high",
    );
    expect(
      prepareCursorProcessing(
        "fast",
        "cursor-grok-4.6-xhigh",
        models.filter((m) => m.id !== "cursor-grok-4.6-xhigh-fast"),
      ).model,
    ).toBe("cursor-grok-4.6-xhigh");
  });
  it("preserves deliberately selected native Fast while Economy never creates Fast", () => {
    expect(
      prepareCursorProcessing("standard", "cursor-grok-4.6-xhigh-fast", models).receipt,
    ).toMatchObject({ submitted: "fast", reason: "native_explicit" });
    expect(prepareCursorProcessing("economy", "cursor-grok-4.6-xhigh", models).model).toBe(
      "cursor-grok-4.6-xhigh",
    );
  });
  it("does not turn catalog failure into a missing model or an invented capability", () => {
    expect(prepareCursorProcessing("fast", "cursor-grok-4.6-xhigh", []).model).toBe(
      "cursor-grok-4.6-xhigh",
    );
    expect(
      cursorProcessingModels(models).find((m) => m.id === "claude-fable-5-1-high")?.processing,
    ).toBeUndefined();
  });
});
