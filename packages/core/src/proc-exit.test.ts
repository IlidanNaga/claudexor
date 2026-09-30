import { describe, expect, it } from "vitest";
import { runCapture, runCaptureRaw } from "./proc.js";

// The direct child exits while its descendant still owns stdout. Native exit
// is observable before close; the existing capture still waits for all bytes.
const exitsBeforePipesClose = [
  "require('node:child_process').spawn(process.execPath, ['-e', \"setTimeout(()=>console.log('tail'),300)\"], {stdio:'inherit'})",
  "process.exit(1)",
].join(";");

describe("capture native exit observation", () => {
  it.each([
    ["line capture", runCapture],
    ["raw capture", runCaptureRaw],
  ] as const)(
    "notifies exit before pipe drain without completing %s early",
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
