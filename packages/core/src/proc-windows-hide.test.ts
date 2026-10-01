import { describe, expect, it, vi } from "vitest";

// A pass-through spy over the REAL spawn: the recorded options prove the window
// policy on every platform, while each child still runs for real, so the
// Windows CI leg consumes the hidden-window spawn instead of a fake.
const spawnSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnSpy.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnSpy };
});

import { runCaptureRaw, spawnProcess } from "./proc.js";

// The hidden window is added to, never traded for, the existing background
// spawn shape: piped stdio in its own process group.
const BACKGROUND_SPAWN = {
  windowsHide: true,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
};

describe("background process window policy", () => {
  it("hides the console window for streamed child processes", async () => {
    const stdout: string[] = [];
    let exitCode: number | null | undefined;
    for await (const ev of spawnProcess(process.execPath, ["-e", "console.log('probe-ok')"])) {
      if (ev.type === "stdout") stdout.push(ev.line);
      if (ev.type === "exit") exitCode = ev.code;
    }

    expect(stdout).toEqual(["probe-ok"]);
    expect(exitCode).toBe(0);
    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(spawnSpy.mock.calls[0]?.[2]).toMatchObject(BACKGROUND_SPAWN);
  });

  it("hides the console window for raw capture child processes", async () => {
    const result = await runCaptureRaw(process.execPath, [
      "-e",
      "process.stdout.write('a\\r\\nb')",
    ]);

    expect(result).toMatchObject({ code: 0, signal: null, stdout: "a\r\nb" });
    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(spawnSpy.mock.calls[0]?.[2]).toMatchObject(BACKGROUND_SPAWN);
  });
});
