import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlSetupJob } from "@claudexor/schema";
import { profileLoginViaSetupJob } from "./profile-login-attach.js";
import { setupAttachCommand, setupCommand } from "./setup-attach-command.js";
import { commandPositionalError, subcommandFlagScopeError } from "./command-scope.js";
import { parseArgs } from "./args.js";

const addr = { baseUrl: "http://127.0.0.1:1", token: "test-only" };
const job = (state = "waiting_for_input", reason?: string) =>
  ControlSetupJob.parse({
    jobId: "setup-test-1",
    harness: "cursor",
    action: "login",
    transport: "client_pty",
    state,
    phase: state === "waiting_for_input" ? "launching" : "completed",
    command: "cursor-agent login",
    guideUrl: "https://example.test/login",
    message: state,
    createdAt: "2026-09-30T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    authCapability: {
      attemptId: "attempt-test",
      challengeDigest: "d".repeat(64),
      requestDigest: "e".repeat(64),
      state: "disclosed",
      disclosure: {
        schemaVersion: 1,
        protocolVersion: 1,
        harness: "cursor",
        requested: "subscription",
        requiredRoute: "vendor_native",
        requiredSource: "native_session",
        networkScope: "selected_harness_only",
        billingKnowledge: "unknown",
        incrementalCostKnowledge: "unknown",
        mayConsumeQuota: true,
        generatedAt: "2026-09-30T00:00:00.000Z",
      },
    },
    ...(reason ? { outcome: { reason } } : {}),
  });
const input = {
  harness: "cursor",
  profileId: "work",
  json: false,
  statusLine: async () => "status",
};
let stdout = "";
let stderr = "";
function capture() {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((value: unknown) => {
    stdout += String(value);
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((value: unknown) => {
    stderr += String(value);
    return true;
  }) as never);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("setup recovery over existing control routes", () => {
  it.each(["cancel", "reconcile"])(
    "projects the daemon's %s response without claiming completion",
    async (action) => {
      capture();
      const fetch = vi.fn(async (_url: string) => Response.json(job()));
      vi.stubGlobal("fetch", fetch);
      expect(
        await setupCommand(
          { _: ["setup", action, "setup-test-1"] },
          true,
          async () => ({ addr }) as never,
        ),
      ).toBe(0);
      expect(fetch.mock.calls[0]?.[0]).toBe(`${addr.baseUrl}/v2/setup/jobs/setup-test-1/${action}`);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, job: { state: "waiting_for_input" } });
      expect(stderr).toBe("");
    },
  );
  it("keeps a failed reconcile typed and visible", async () => {
    capture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "conflict", message: "process group is still alive", retryable: true },
          { status: 409 },
        ),
      ),
    );
    expect(
      await setupCommand(
        { _: ["setup", "reconcile", "setup-test-1"] },
        true,
        async () => ({ addr }) as never,
      ),
    ).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      code: "conflict",
      retryable: true,
      message: expect.stringContaining("still alive"),
    });
  });
  it("advertises only the full CLI recovery verbs and keeps packaged entry attach-only", async () => {
    capture();
    for (const verb of ["cancel", "reconcile"]) {
      const args = parseArgs(["setup", verb, "setup-test-1", "--json"]);
      expect(commandPositionalError("setup", args._.slice(1))).toBeNull();
      expect(subcommandFlagScopeError("setup", verb, ["json"])).toBeNull();
      expect(await setupAttachCommand(args._, true)).toBe(2);
    }
    expect(await setupAttachCommand(["setup", "attach", "setup-test-1"], true)).toBe(2);
  });
});

describe("profile login terminal recovery", () => {
  it("refuses JSON before daemon access or job creation", async () => {
    capture();
    const ensureDaemon = vi.fn();
    expect(await profileLoginViaSetupJob({ ...input, json: true }, { ensureDaemon })).toBe(2);
    expect(ensureDaemon).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, exitCode: 2 });
  });
  it("names a fenced job and concrete recovery without attaching or recreating", async () => {
    capture();
    const fetch = vi.fn(async () => Response.json(job("failed", "termination_unconfirmed")));
    vi.stubGlobal("fetch", fetch);
    const attach = vi.fn();
    expect(
      await profileLoginViaSetupJob(input, { ensureDaemon: async () => ({ addr }), attach }),
    ).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(attach).not.toHaveBeenCalled();
    expect(stdout).toContain("setup cancel setup-test-1");
    expect(stdout).toContain("setup reconcile setup-test-1");
  });
  it.each(["SIGINT", "SIGHUP", "SIGTERM"] as const)(
    "%s shares daemon cancellation and removes its handlers",
    async (signal) => {
      capture();
      const initial = process.listenerCount(signal);
      let cancelled = false;
      const fetch = vi.fn(async (url: string) => {
        if (url.endsWith("/cancel")) cancelled = true;
        return Response.json(cancelled ? job("cancelled", "cancelled_by_user") : job());
      });
      vi.stubGlobal("fetch", fetch);
      const code = await profileLoginViaSetupJob(input, {
        ensureDaemon: async () => ({ addr }),
        receiptExists: () => false,
        attach: async () => {
          (process.listeners(signal).at(-1) as () => void)();
          return 1;
        },
      });
      expect(code).toBe(130);
      expect(fetch.mock.calls.filter(([url]) => url.endsWith("/cancel"))).toHaveLength(1);
      expect(process.listenerCount(signal)).toBe(initial);
    },
  );
  it("discloses an undelivered cancellation once while retaining the same job", async () => {
    capture();
    let interrupt: () => void = () => {};
    let requested = false;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/cancel")) {
        requested = true;
        throw new Error("connection refused");
      }
      return Response.json(requested ? job("cancelled", "cancelled_by_user") : job());
    });
    vi.stubGlobal("fetch", fetch);
    expect(
      await profileLoginViaSetupJob(input, {
        ensureDaemon: async () => ({ addr }),
        receiptExists: () => false,
        onInterrupt: (handler) => {
          interrupt = handler;
          return () => {};
        },
        attach: async () => {
          interrupt();
          return 1;
        },
      }),
    ).toBe(130);
    expect(stderr.match(/could not deliver cancellation/g)).toHaveLength(1);
    expect(stderr).toContain("setup cancel setup-test-1");
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/cancel"))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/setup/jobs"))).toHaveLength(1);
  });
});
