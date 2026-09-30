import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { runCliHarness, type CliRunLoopOptions } from "@claudexor/core";
import { createClaudeAdapter } from "./index.js";

function spec(over: Partial<HarnessRunSpec> = {}): HarnessRunSpec {
  return HarnessRunSpec.parse({
    session_id: "claude-input",
    intent: "implement",
    prompt: "do it",
    cwd: process.cwd(),
    access: "full",
    auth_preference: "subscription",
    ...over,
  });
}
function adapter(run: typeof runCliHarness) {
  return createClaudeAdapter({
    probeAuthStatus: async () => ({
      loggedIn: true,
      authed: true,
      authMethod: "claude.ai",
      probeError: null,
    }),
    anthropicApiKey: () => null,
    claudeOAuthToken: () => null,
    probeEffortLevels: async () => ({ levels: [], live: true }),
    runCliHarness: run,
  });
}
async function collect(stream: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function instructionsPath(options: CliRunLoopOptions): string {
  const index = options.args.indexOf("--append-system-prompt-file");
  expect(index).toBeGreaterThan(-1);
  return options.args[index + 1]!;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("Claude exact input transport and file lifecycle", () => {
  it.each(["short", "large"])(
    "delivers %s prompt and instructions byte-exact through the child",
    async (size) => {
      const unit = '  Русский 🙂 "quoted"\nline\t end  ';
      const prompt = size === "large" ? unit.repeat(90_000) : unit;
      const instructions = `system-role\n${prompt}\n `;
      let ownedPath = "";
      const child = `
      const fs = require('node:fs'); const crypto = require('node:crypto');
      const hash = value => crypto.createHash('sha256').update(value).digest('hex');
      const args = JSON.parse(process.argv[1]);
      const file = args[args.indexOf('--append-system-prompt-file') + 1];
      const input = fs.readFileSync(0); const system = fs.readFileSync(file);
      console.log(JSON.stringify({type:'result', subtype:'success', result:JSON.stringify({
        input:hash(input), system:hash(system), inputBytes:input.length, systemBytes:system.length
      })}));
    `;
      const events = await collect(
        adapter((options) => {
          ownedPath = instructionsPath(options);
          expect(options.args).not.toContain(prompt);
          expect(options.args).not.toContain(instructions);
          expect(options.args[options.args.indexOf("--input-format") + 1]).toBe("text");
          expect(options.session).toBeUndefined();
          expect(options.input).toBe(prompt);
          expect(ownedPath.startsWith(options.spec.cwd)).toBe(false);
          if (process.platform !== "win32") {
            expect(statSync(ownedPath).mode & 0o777).toBe(0o600);
            expect(statSync(dirname(ownedPath)).mode & 0o777).toBe(0o700);
          }
          return runCliHarness({
            ...options,
            bin: process.execPath,
            args: ["-e", child, JSON.stringify(options.args)],
          });
        }).run(spec({ prompt, instructions })),
      );
      const final = events.find((event) => event.type === "message" && event.final);
      expect(final?.text).toBeDefined();
      expect(JSON.parse(final!.text!)).toEqual({
        input: digest(prompt),
        system: digest(instructions),
        inputBytes: Buffer.byteLength(prompt),
        systemBytes: Buffer.byteLength(instructions),
      });
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(existsSync(dirname(ownedPath))).toBe(false);
    },
  );

  it("keeps interactive stdin, native resume and exact system append separate", async () => {
    let ownedPath = "";
    const prompt = " user text \n🙂 ";
    const instructions = " system text \n🙂 ";
    await collect(
      adapter(async function* (options) {
        ownedPath = instructionsPath(options);
        expect(readFileSync(ownedPath, "utf8")).toBe(instructions);
        expect(options.input).toBeUndefined();
        const frames = options
          .session!.initialStdin!.trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(frames[0].request.subtype).toBe("initialize");
        expect(frames[1].message.content).toEqual([{ type: "text", text: prompt }]);
        expect(options.args[options.args.indexOf("--resume") + 1]).toBe("native-turn");
        expect(options.args).toContain("--replay-user-messages");
        yield {
          type: "completed",
          session_id: options.spec.session_id,
          ts: new Date().toISOString(),
        };
      }).run(
        spec({
          prompt,
          instructions,
          resume_session_id: "native-turn",
          extra: { interactionChannel: { request: async () => null } },
        }),
      ),
    );
    expect(existsSync(dirname(ownedPath))).toBe(false);
  });

  it("cleans the file after a real spawn failure", async () => {
    let ownedPath = "";
    const events = await collect(
      adapter((options) => {
        ownedPath = instructionsPath(options);
        return runCliHarness({ ...options, bin: "/missing-claude-input-fixture/claude" });
      }).run(spec({ instructions: "system" })),
    );
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(existsSync(dirname(ownedPath))).toBe(false);
  });

  it("keeps image attachments on stream-json stdin without an interaction channel", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-input-image-"));
    const path = join(root, "image.png");
    const bytes = Buffer.from("iVBORw0KGgo=", "base64");
    writeFileSync(path, bytes);
    let ownedPath = "";
    try {
      await collect(
        adapter(async function* (options) {
          ownedPath = instructionsPath(options);
          expect(options.input).toBeUndefined();
          expect(options.args[options.args.indexOf("--input-format") + 1]).toBe("stream-json");
          const frames = options
            .session!.initialStdin!.trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(frames[1].message.content).toEqual([
            { type: "text", text: "describe" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
            },
          ]);
          expect(readFileSync(ownedPath, "utf8")).toBe("system");
          yield {
            type: "completed",
            session_id: options.spec.session_id,
            ts: new Date().toISOString(),
          };
        }).run(
          spec({
            prompt: "describe",
            instructions: "system",
            attachments: [
              {
                resource_id: "image-fixture",
                kind: "image",
                mime: "image/png",
                name: "image.png",
                path,
                sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
                size_bytes: bytes.length,
              },
            ],
          }),
        ),
      );
      expect(existsSync(dirname(ownedPath))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the file until a cancelled child is reaped, then removes it", async () => {
    const controller = new AbortController();
    let ownedPath = "";
    const stream = adapter((options) => {
      ownedPath = instructionsPath(options);
      return runCliHarness({
        ...options,
        bin: process.execPath,
        args: [
          "-e",
          `
        console.log(JSON.stringify({type:'assistant', message:{content:[{type:'text',text:'ready'}]}}));
        setInterval(() => {}, 1000);
      `,
        ],
      });
    }).run(spec({ instructions: "system", extra: { abortSignal: controller.signal } }));
    let sawReady = false;
    for await (const event of stream) {
      if (event.type === "message" && event.text === "ready") {
        sawReady = true;
        expect(existsSync(ownedPath)).toBe(true);
        controller.abort();
      }
    }
    expect(sawReady).toBe(true);
    expect(existsSync(dirname(ownedPath))).toBe(false);
  });

  it("cleans the file when the delegated run iterator throws", async () => {
    let ownedPath = "";
    await expect(
      collect(
        adapter(async function* (options) {
          ownedPath = instructionsPath(options);
          throw new Error("fixture failure before spawn");
        }).run(spec({ instructions: "system" })),
      ),
    ).rejects.toThrow("fixture failure before spawn");
    expect(existsSync(dirname(ownedPath))).toBe(false);
  });
});
