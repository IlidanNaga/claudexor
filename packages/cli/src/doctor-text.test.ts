import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  controlApiFetch: vi.fn(),
}));

// Partial mocks (spread the real module) so the wide ops-commands import graph
// keeps every other export intact — only the daemon seam is stubbed.
vi.mock("./daemon-run.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureDaemon: mocks.ensureDaemon,
}));
vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  controlApiFetch: mocks.controlApiFetch,
}));

import { parseArgs } from "./args.js";
import { doctorCommand } from "./ops-commands.js";

function harness(configuredModelCheck: { status: "ok" | "rejected"; message?: string | null }) {
  return {
    harnesses: [
      {
        id: "claude",
        available: true,
        status: "ok",
        manifest: null,
        authSources: [],
        enabledIntents: ["explain"],
        routableIntents: ["explain"],
        disabledIntents: [],
        checks: [],
        reasons: [],
        configuredModel: "claude-opus-5-5",
        configuredModelCheck,
      },
    ],
  };
}

describe("the human doctor output and the configured-model verdict (INV-104)", () => {
  let out: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    mocks.ensureDaemon.mockResolvedValue({ addr: { host: "127.0.0.1", port: 1, token: "t" } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function doctorText(check: { status: "ok" | "rejected"; message?: string | null }) {
    mocks.controlApiFetch.mockResolvedValue(
      new Response(JSON.stringify(harness(check)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await doctorCommand(parseArgs(["doctor", "--harness", "claude"]), false)).toBe(0);
    return out.join("");
  }

  it("prints the admission note of an advisory harness beside the model", async () => {
    const text = await doctorText({
      status: "ok",
      message: 'model "claude-opus-5-5" is not in this account\'s listed models; forwarded',
    });
    expect(text).toContain(
      'model: claude-opus-5-5 — model "claude-opus-5-5" is not in this account\'s listed models; forwarded',
    );
  });

  it("stays silent for a listed model and still shouts for a refused one", async () => {
    expect(await doctorText({ status: "ok", message: null })).not.toContain("model:");
    out.length = 0;
    expect(await doctorText({ status: "rejected", message: "not in the truth source" })).toContain(
      "model: INVALID — not in the truth source",
    );
  });
});
