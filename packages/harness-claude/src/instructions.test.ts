import { describe, expect, it } from "vitest";
import type { HarnessRunSpec } from "@claudexor/schema";
import { claudeArgsForSpec } from "./index.js";

function spec(over: Partial<HarnessRunSpec> = {}): HarnessRunSpec {
  return {
    session_id: "s1",
    intent: "implement",
    prompt: "do it",
    cwd: "/repo",
    access: "workspace_write",
    external_context_policy: "auto",
    tool_permission_policy: { web: "auto", allow: [], deny: [] },
    model_hint: null,
    effort_hint: null,
    max_turns: null,
    auth_preference: "auto",
    resume_session_id: null,
    env: {},
    extra: {},
    ...over,
  } as HarnessRunSpec;
}

describe("claude --append-system-prompt-file (W5)", () => {
  it("appends caller instructions in both the one-shot and interactive transports", () => {
    for (const interactive of [false, true]) {
      const args = claudeArgsForSpec(
        spec({ instructions: "be terse" }),
        interactive,
        false,
        undefined,
        "/private-input/instructions.txt",
      );
      const idx = args.indexOf("--append-system-prompt-file");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("/private-input/instructions.txt");
      expect(args).not.toContain("be terse");
      expect(args).not.toContain("--append-system-prompt");
    }
  });

  it("omits the flag when there are no instructions", () => {
    expect(claudeArgsForSpec(spec())).not.toContain("--append-system-prompt-file");
    expect(claudeArgsForSpec(spec({ instructions: "  " }))).not.toContain(
      "--append-system-prompt-file",
    );
  });
  it("cannot silently omit instructions when its owned file is missing", () => {
    expect(() => claudeArgsForSpec(spec({ instructions: "be terse" }))).toThrow(
      "require an owned file",
    );
  });
});
