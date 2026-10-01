import { describe, expect, it } from "vitest";
import { runCapture, runCaptureRaw } from "./proc.js";

// POSIX-only inheritance proof: Windows libuv puts a non-detached child in
// its parent's kill-on-close Job Object, so immediate parent exit kills this
// descendant before it can write. The direct-child proof below runs everywhere.
const exitsBeforePipesClose = [
  "require('node:child_process').spawn(process.execPath, ['-e', \"setTimeout(()=>console.log('tail'),300)\"], {stdio:'inherit'})",
  "process.exit(1)",
].join(";");

const captures = [
  ["line capture", runCapture],
  ["raw capture", runCaptureRaw],
] as const;

describe("capture native exit observation", () => {
  it.each(captures)(
    "observes native exit before %s completes and retains the child's bytes",
    async (_label, capture) => {
      let completed = false;
      const exits: Array<{
        code: number | null;
        signal: NodeJS.Signals | null;
        completed: boolean;
      }> = [];
      // A synchronous direct-child write is guaranteed before exit on every
      // platform; no descendant or inherited-pipe lifetime is assumed.
      const result = await capture(
        process.execPath,
        ["-e", "require('node:fs').writeSync(1, 'direct\\n'); process.exit(1)"],
        {
          onExit: (code, signal) => exits.push({ code, signal, completed }),
        },
      ).then((value) => {
        completed = true;
        return value;
      });
      expect(exits).toEqual([{ code: 1, signal: null, completed: false }]);
      expect(result).toEqual({ code: 1, signal: null, stdout: "direct\n", stderr: "" });
    },
  );

  it.skipIf(process.platform === "win32").each(captures)(
    "on POSIX, notifies exit before inherited pipe drain without completing %s early",
    async (_label, capture) => {
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      let completed = false;
      const exits: Array<[number | null, NodeJS.Signals | null]> = [];
      const result = capture(process.execPath, ["-e", exitsBeforePipesClose], {
        onExit: (code, signal) => {
          exits.push([code, signal]);
          resolveExit();
        },
      }).then((value) => {
        completed = true;
        return value;
      });
      await exited;
      expect(exits).toEqual([[1, null]]);
      expect(completed).toBe(false);
      expect(await result).toEqual({ code: 1, signal: null, stdout: "tail\n", stderr: "" });
      expect(exits).toHaveLength(1);
    },
  );
});
