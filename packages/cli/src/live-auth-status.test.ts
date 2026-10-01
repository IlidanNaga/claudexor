import { describe, expect, it } from "vitest";
import { AnswerAssembly } from "@claudexor/core";
import type { HarnessEvent } from "@claudexor/schema";
import { staleClaudeAuthStatusEvent } from "../../harness-claude/src/auth-status.js";
import { staleCursorAuthEvent } from "../../harness-cursor/src/profile.js";
import { harnessEventPayload } from "../../orchestrator/src/runSupport.js";
import { createRunEventLineFormatter } from "./live.js";

const cursor = staleCursorAuthEvent("s", {
  observedAt: "2026-09-28T19:52:00.000Z",
  ageMs: 95_000,
});
const claude = staleClaudeAuthStatusEvent("s", 42);
const project = (harness: string, event: HarnessEvent) => ({
  type: "harness.event",
  payload: harnessEventPayload(harness, "a01", event),
});

describe("typed stale-auth human disclosure", () => {
  it.each([
    ["cursor", cursor],
    ["claude", claude],
  ] as const)(
    "renders %s's real producer through the run projection without answer text",
    (id, event) => {
      const answer = new AnswerAssembly();
      answer.observe(event);
      expect(answer.text()).toBe("");
      const format = createRunEventLineFormatter();
      expect(format(project(id, event))).toBe(`[a01/${id}] WARNING: ${event.text}`);
      // A real answer stays visible even if it quotes the disclosure verbatim.
      const message = { ...event, type: "message" as const, payload: undefined, final: true };
      answer.observe(message);
      expect(answer.text()).toBe(event.text);
      expect(format(project(id, message))).toBe(`[a01/${id}] ${event.text}`);
    },
  );

  it("requires the typed marker, not status wording, and leaves unrelated statuses quiet", () => {
    const format = createRunEventLineFormatter();
    expect(format(project("cursor", { ...cursor, payload: {} }))).toBeNull();
    expect(
      format(project("cursor", { ...cursor, payload: { auth_status_stale: false } })),
    ).toBeNull();
    expect(
      format(project("cursor", { ...cursor, text: "Checking workspace", payload: {} })),
    ).toBeNull();
    expect(format(project("cursor", { ...cursor, text: "Typed observation" }))).toBe(
      "[a01/cursor] WARNING: Typed observation",
    );
  });
});
