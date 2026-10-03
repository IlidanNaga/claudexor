import { expect, it, vi } from "vitest";
import { HarnessRunSpec } from "@claudexor/schema";

const captured = vi.hoisted(() => ({ bin: "", args: [] as string[] }));

vi.mock("./proc.js", () => ({
  spawnProcess: async function* (bin: string, args: string[]) {
    captured.bin = bin;
    captured.args = [...args];
    yield { type: "exit", code: 0, signal: null };
  },
}));

import { runCliHarness } from "./runloop.js";

it("spawns the requested harness binary and argv directly", async () => {
  const spec = HarnessRunSpec.parse({
    session_id: "ses-direct",
    intent: "implement",
    prompt: "hello",
    cwd: process.cwd(),
  });
  const events = [];
  for await (const event of runCliHarness({
    bin: "/opt/vendor/bin/codex",
    args: ["exec", "--json", "hello"],
    spec,
    parseEvent: () => [],
  })) {
    events.push(event);
  }

  expect(captured).toEqual({
    bin: "/opt/vendor/bin/codex",
    args: ["exec", "--json", "hello"],
  });
  expect(captured.bin).not.toContain("sandbox-exec");
  expect(events.at(-1)?.type).toBe("completed");
});
