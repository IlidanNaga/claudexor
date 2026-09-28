/** Golden Settings contracts kept separate from the general CLI story so the
 * public validation matrix stays readable and below the complexity ratchet. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox } from "./support.js";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.dispose();
});

describe("settings canary golden stories", () => {
  it("[INV-104:settings-write-strict] refuses settings outside an authoritative harness's truth and persists nothing", () => {
    // agy's manifest known_models is the offline truth source here, and agy
    // declares nothing about absence: its list is complete, a miss is refused.
    const bad = cli(sb, [
      "settings",
      "set",
      "harness.agy.default_model",
      "ghost-model-9000",
      "--json",
    ]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toBe("");
    expect(JSON.parse(bad.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "invalid_request",
      retryable: false,
    });
    expect(bad.stdout + bad.stderr).toMatch(/refused|not in the harness/i);

    const invalidGoal = cli(sb, ["settings", "set", "routing_goal", "quality", "--json"]);
    expect(invalidGoal.code).toBe(2);
    expect(invalidGoal.stderr).toBe("");
    expect(JSON.parse(invalidGoal.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "config_error",
      retryable: false,
    });

    const show = cli(sb, ["settings", "show", "--json"]);
    expect(show.stdout).not.toContain("ghost-model-9000");
    expect(show.json()).toMatchObject({ routing: { goal: "auto" } });
    const good = cli(sb, ["settings", "set", "harness.agy.default_model", "gemini-3.7-flash-high"]);
    expect(good.code).toBe(0);
    expect(good.stdout).not.toContain("note:"); // presence is proof: nothing to disclose
    const show2 = cli(sb, ["settings", "show", "--json"]);
    expect(show2.stdout).toContain("gemini-3.7-flash-high");

    // Fakes are test fixtures, never persistable routing targets.
    const fake = cli(sb, ["settings", "set", "harness.fake-success.default_model", "fake-model"]);
    expect(fake.code).toBe(2);
    expect(fake.stdout + fake.stderr).toMatch(/fake-success.*(?:not persistable|not a real)/i);
  });

  it("[INV-104:settings-write-advisory] persists a model an advisory harness's list lacks and says so once", () => {
    // codex declares absence advisory: its lists prove presence, never absence.
    // An unlisted explicit model is persisted (it will be forwarded to the
    // vendor at run time) and the write's read-back carries the note.
    const set = cli(sb, [
      "settings",
      "set",
      "harness.codex.default_model",
      "gpt-ghost-9000",
      "--json",
    ]);
    expect(set.code).toBe(0);
    expect(set.stderr).toBe("");
    const snapshot = set.json() as {
      notes: string[];
      harnesses: Record<string, { defaultModel: string | null }>;
    };
    expect(snapshot.harnesses["codex"]?.defaultModel).toBe("gpt-ghost-9000");
    expect(snapshot.notes).toEqual([
      expect.stringMatching(
        /^harness 'codex' defaultModel 'gpt-ghost-9000' \(truth source: manifest\): model "gpt-ghost-9000" is not in this harness's manifest known-model list; .*forwarded to the vendor$/,
      ),
    ]);
    // The human form prints the same note once; a plain read carries none.
    const plain = cli(sb, ["settings", "set", "harness.codex.default_model", "gpt-ghost-9000"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toMatch(
      /^updated harness\.codex\.default_model\nnote: harness 'codex' defaultModel 'gpt-ghost-9000'/,
    );
    const show = cli(sb, ["settings", "show", "--json"]);
    expect(show.json()).toMatchObject({
      notes: [],
      harnesses: { codex: { defaultModel: "gpt-ghost-9000" } },
    });
    // A listed model passes silently: presence is proof.
    const listed = cli(sb, ["settings", "set", "harness.codex.default_model", "gpt-5.5", "--json"]);
    expect(listed.code).toBe(0);
    expect((listed.json() as { notes: string[] }).notes).toEqual([]);
  });

  it("[INV-103:no-global-model] validates retired local input before daemon bootstrap", () => {
    const r = cli(sb, ["settings", "set", "default_model", "gpt-5.5"]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/harness-scoped|harness\.<id>\.default_model/);
    expect(existsSync(join(sb.configDir, "daemon", "control-api.json"))).toBe(false);

    const invalidBoolean = cli(sb, [
      "settings",
      "set",
      "harness.claude.enabled",
      "maybe",
      "--json",
    ]);
    expect(invalidBoolean.code).toBe(2);
    expect(() => JSON.parse(invalidBoolean.stdout)).not.toThrow();
    expect(existsSync(join(sb.configDir, "daemon", "control-api.json"))).toBe(false);
  });
});
