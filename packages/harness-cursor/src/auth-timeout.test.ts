import { describe, expect, it, vi } from "vitest";
import { runCapture } from "@claudexor/core";
import { probeCursorNativeAuth } from "./auth.js";

const ENV = { AGENT_CLI_CREDENTIAL_STORE: "file", CURSOR_CONFIG_DIR: "/tmp/offline-cursor" };

describe("Cursor status owns first observed timeout cause", () => {
  it("an observed exit before delayed pipe closure stays a plain failure even when the timer fires", async () => {
    // Real process, not an invented CaptureResult: the descendant holds stdout
    // after its parent has exited. The timeout may clean up that descendant,
    // but cannot reclassify the already observed parent's exit as unanswered.
    const child =
      "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:'inherit'});process.exit(1)";
    const result = await probeCursorNativeAuth(
      ENV,
      undefined,
      (_bin, _args, opts) => runCapture(process.execPath, ["-e", child], opts),
      400,
    );
    expect(result).toEqual({ kind: "unknown", error: "cursor-agent status failed (1)" });
  });

  it.each([0, 1])(
    "keeps a timer-aborted cooperative code %s exit as timeout without a signal requirement",
    async (code) => {
      const capture: typeof runCapture = vi.fn(async (_bin, _args, opts) => {
        await new Promise<void>((resolve) =>
          opts?.abortSignal?.addEventListener(
            "abort",
            () => {
              opts.onExit?.(code, null);
              resolve();
            },
            { once: true },
          ),
        );
        return { code, signal: null, stdout: "", stderr: "unknown option --format" };
      });
      const result = await probeCursorNativeAuth(ENV, undefined, capture, 20);
      expect(result).toMatchObject({ kind: "unknown", timedOut: true });
      // A timed-out format response must not start a second status child.
      expect(capture).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a recognized logged-out answer authoritative even when pipe completion follows the timer", async () => {
    const capture: typeof runCapture = async (_bin, _args, opts) => {
      await new Promise<void>((resolve) =>
        opts?.abortSignal?.addEventListener(
          "abort",
          () => {
            opts.onExit?.(0, null);
            resolve();
          },
          { once: true },
        ),
      );
      return { code: 0, signal: null, stdout: '{"authenticated":false}', stderr: "" };
    };
    expect(await probeCursorNativeAuth(ENV, undefined, capture, 20)).toEqual({ kind: "loggedOut" });
  });

  it("caller cancellation observed first stays cancellation through later timer and exit", async () => {
    const caller = new AbortController();
    const capture: typeof runCapture = async (_bin, _args, opts) => {
      caller.abort();
      await new Promise((resolve) => setTimeout(resolve, 40));
      opts?.onExit?.(1, null);
      return { code: 1, signal: null, stdout: "", stderr: "" };
    };
    expect(await probeCursorNativeAuth(ENV, caller.signal, capture, 20)).toEqual({
      kind: "unknown",
      error: "cursor-agent status failed (1)",
    });
  });
});
