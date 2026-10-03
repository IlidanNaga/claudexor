import { describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";
import { createCursorAdapter } from "./index.js";

/**
 * Claim-8 regression pin. Live probe evidence (2026-08-03, cursor-agent
 * 2026.07.23-e383d2b): under the PREVIOUS readonly argv
 * (`-p --output-format stream-json --sandbox enabled --trust`) the agent
 * CREATED a file on instruction — print mode "has access to all tools,
 * including write and shell" and `--sandbox` gates commands, not file edits.
 * Under the same argv plus `--mode ask` it refused: "I'm in Ask mode right
 * now, so I can't create or modify files." Ask mode is therefore the only
 * mechanism this CLI has that enforces readonly, and the `readonly` access
 * profile must dispatch onto it.
 */

const spec = (overrides: Partial<HarnessRunSpec> = {}): HarnessRunSpec =>
  HarnessRunSpec.parse({
    session_id: "s-cursor-readonly",
    intent: "review",
    prompt: "review this",
    cwd: "/repo",
    // Unified account model (D-U3): a native cursor session is probed only in
    // a vendor FILE-store env (an account row's HOME); these argv tests ride
    // one so the stubbed authenticated probe still routes the spawn.
    env: { AGENT_CLI_CREDENTIAL_STORE: "file" },
    ...overrides,
  });

async function argsFor(runSpec: HarnessRunSpec): Promise<string[]> {
  let captured: string[] | undefined;
  const adapter = createCursorAdapter({
    detectVersion: async () => "cursor-test",
    nativeAuthOk: async () => ({ kind: "authenticated" }),
    cursorApiKey: () => null,
    runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
      captured = [...opts.args];
      yield {
        type: "completed",
        session_id: opts.spec.session_id,
        ts: "2026-01-01T00:00:00.000Z",
      };
    },
  });
  for await (const ev of adapter.run(runSpec)) void ev;
  expect(captured, "the CLI was never invoked").toBeDefined();
  return captured as string[];
}

const modesOf = (args: string[]): string[] =>
  args.flatMap((arg, i) => (arg === "--mode" ? [args[i + 1] ?? ""] : []));

describe("cursor readonly access dispatches onto Ask mode", () => {
  it.each(["auto", "cached", "live"] as const)(
    "readonly %s enables optional native web while keeping Ask + sandbox",
    async (externalContextPolicy) => {
      const args = await argsFor(
        spec({ access: "readonly", external_context_policy: externalContextPolicy }),
      );
      expect(modesOf(args)).toEqual(["ask"]);
      expect(args).toContain("--force");
      expect(args).toContain("--sandbox");
      expect(args[args.indexOf("--sandbox") + 1]).toBe("enabled");
    },
  );

  it("readonly off keeps web disabled and does not inject force", async () => {
    const args = await argsFor(spec({ access: "readonly", external_context_policy: "off" }));
    expect(modesOf(args)).toEqual(["ask"]);
    expect(args).toContain("--sandbox");
    expect(args).not.toContain("--force");
  });

  it("inherit_native never injects force", async () => {
    const args = await argsFor(spec({ access: "inherit_native", external_context_policy: "live" }));
    expect(args).not.toContain("--force");
  });

  it("workspace_write keeps the full agent mode (no --mode flag)", async () => {
    const args = await argsFor(spec({ access: "workspace_write" }));
    expect(modesOf(args)).toEqual([]);
  });

  it("plan intent + readonly access yields exactly one --mode ask", async () => {
    const args = await argsFor(spec({ access: "readonly", intent: "plan" }));
    expect(modesOf(args)).toEqual(["ask"]);
  });

  it("plan intent alone still rides Ask mode (pre-existing behavior)", async () => {
    const args = await argsFor(spec({ intent: "plan" }));
    expect(modesOf(args)).toEqual(["ask"]);
  });
});

async function runCollecting(
  runSpec: HarnessRunSpec,
): Promise<{ events: HarnessEvent[]; args: string[] | null; input: string | null }> {
  let captured: string[] | null = null;
  let input: string | null = null;
  const adapter = createCursorAdapter({
    detectVersion: async () => "cursor-test",
    nativeAuthOk: async () => ({ kind: "authenticated" }),
    cursorApiKey: () => null,
    runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
      captured = [...opts.args];
      input = opts.input ?? null;
      yield {
        type: "completed",
        session_id: opts.spec.session_id,
        ts: "2026-01-01T00:00:00.000Z",
      };
    },
  });
  const events: HarnessEvent[] = [];
  for await (const ev of adapter.run(runSpec)) events.push(ev);
  return { events, args: captured, input };
}

describe("cursor one-shot prompt transport", () => {
  it("keeps prompt bytes out of argv and composes instructions on stdin for resume", async () => {
    const prompt = "review the frozen packet";
    const { args, input } = await runCollecting(
      spec({
        access: "readonly",
        prompt,
        instructions: "Return one verdict.",
        resume_session_id: "cursor-thread-1",
      }),
    );
    expect(args).not.toBeNull();
    const argv = args as unknown as string[];
    expect(argv).not.toContain(prompt);
    expect(argv).not.toContain(input);
    expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual([
      "--resume",
      "cursor-thread-1",
    ]);
    expect(modesOf(argv)).toEqual(["ask"]);
    expect(input).toBe(
      "[SYSTEM INSTRUCTIONS]\nReturn one verdict.\n[END SYSTEM INSTRUCTIONS]\n\n" + prompt,
    );
  });
});

describe("cursor trusted full access", () => {
  it("maps full to --force --sandbox disabled --trust", async () => {
    const { events, args } = await runCollecting(spec({ access: "full" }));
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(args).not.toBeNull();
    const argv = args as unknown as string[];
    expect(argv).toContain("--force");
    expect(argv).toContain("--trust");
    const sandboxIdx = argv.indexOf("--sandbox");
    expect(sandboxIdx).toBeGreaterThanOrEqual(0);
    expect(argv[sandboxIdx + 1]).toBe("disabled");
    // Full access uses the vendor's disabled-sandbox argv and never Ask mode.
    expect(modesOf(argv)).toEqual([]);
  });

  it("declares ordinary full and no retired access in the manifest", async () => {
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => ({ kind: "authenticated" }),
      cursorApiKey: () => null,
    });
    const manifest = await adapter.discover();
    expect(manifest.access_profiles_supported).toContain("full");
    expect(manifest.access_profiles_supported).not.toContain("external_sandbox_full");
  });
});
