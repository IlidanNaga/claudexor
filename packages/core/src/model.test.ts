import { describe, expect, it } from "vitest";
import { hasModelInventoryForRoute, validateModel } from "./model.js";

describe("validateModel (strict model-truth validation)", () => {
  const known = ["sonnet", "opus", "claude-opus-4-8"];

  it("is ok when no model is requested (the harness default is used)", () => {
    expect(validateModel(null, known).status).toBe("ok");
    expect(validateModel(undefined, known).status).toBe("ok");
    expect(validateModel("", known).status).toBe("ok");
  });

  it("is ok for a known alias/id", () => {
    expect(validateModel("opus", known).status).toBe("ok");
    expect(validateModel("claude-opus-4-8", known).status).toBe("ok");
    expect(validateModel("  opus  ", known).status).toBe("ok"); // trimmed
  });

  it("REJECTS an explicit model when the harness has no truth list (never forwarded to die natively)", () => {
    const manifest = validateModel("anything", [], "manifest");
    expect(manifest.status).toBe("rejected");
    expect(manifest.message).toContain("cannot verify models");
    expect(manifest.message).toContain("manifest known_models");
    const api = validateModel("anything", [], "api");
    expect(api.status).toBe("rejected");
    expect(api.message).toContain("live model inventory");
    expect(api.message).toContain("repair the live account/auth route");
    expect(api.message).not.toContain("known_models");
  });

  it("REJECTS a miss naming the truth source and the list (the fable regression, now typed)", () => {
    const r = validateModel("fable-x", known, "manifest");
    expect(r.status).toBe("rejected");
    expect(r.message).toContain('model "fable-x"');
    expect(r.message).toContain("manifest known-model list");
    expect(r.message).toContain("sonnet");
  });

  it("REJECTS an api-inventory miss", () => {
    const r = validateModel("ghost", ["gpt-4o", "gpt-4o-mini"], "api");
    expect(r.status).toBe("rejected");
    expect(r.message).toContain("live model inventory");
  });

  it("truncates giant truth lists in the refusal message", () => {
    const big = Array.from({ length: 120 }, (_, i) => `m-${i}`);
    const r = validateModel("nope", big, "api");
    expect(r.status).toBe("rejected");
    expect(r.message).toContain("(120 total)");
  });
});

/**
 * An ADVISORY live inventory (INV-104, owner-approved 2026-09-21): a producer
 * that cannot tell its own answer from a substituted one proves PRESENCE only.
 * Absence stops being a reason to refuse — the explicit model is forwarded to
 * the vendor and the note says so. Everything else keeps today's exact text,
 * including the manifest, which always speaks for itself.
 */
describe("validateModel with an advisory live inventory", () => {
  const stale = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"];

  it("FORWARDS a model the live list lacks, with the unverified note", () => {
    const r = validateModel("gpt-6-astra", stale, "api", "advisory");
    expect(r.status).toBe("ok");
    expect(r.unverified).toBe(true);
    expect(r.message).toBe(
      "model \"gpt-6-astra\" is not in this account's listed models; this harness's list " +
        "cannot prove a model is absent, so the request is forwarded to the vendor",
    );
  });

  it("FORWARDS on an empty live list (the second live failure mode), saying which case it is", () => {
    const r = validateModel("gpt-6-astra", [], "api", "advisory");
    expect(r.status).toBe("ok");
    expect(r.unverified).toBe(true);
    expect(r.message).toBe(
      "the harness returned no model list; this harness's list cannot prove a model is " +
        "absent, so the request is forwarded to the vendor",
    );
  });

  it("stays silent for a LISTED model: presence is proof, so there is nothing to disclose", () => {
    const r = validateModel("gpt-5.5", stale, "api", "advisory");
    expect(r.status).toBe("ok");
    expect(r.message).toBeNull();
    expect(r.unverified).toBeUndefined();
    const none = validateModel(null, stale, "api", "advisory");
    expect(none.status).toBe("ok");
    expect(none.message).toBeNull();
    expect(none.unverified).toBeUndefined();
  });

  it("NEVER weakens manifest truth — the manifest is this repo's own declaration", () => {
    const miss = validateModel("gpt-6-astra", stale, "manifest", "advisory");
    expect(miss.status).toBe("rejected");
    expect(miss.unverified).toBeUndefined();
    expect(miss.message).toBe(
      'model "gpt-6-astra" is not in the harness\'s manifest known-model list ' +
        "(gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2)",
    );
    const empty = validateModel("gpt-6-astra", [], "manifest", "advisory");
    expect(empty.status).toBe("rejected");
    expect(empty.message).toBe(
      "this harness cannot verify models (no manifest known_models); use the harness " +
        "default (omit the model) or add known_models to the manifest",
    );
  });

  it("keeps the authoritative refusals byte-identical, explicitly and by default", () => {
    for (const check of [
      validateModel("gpt-6-astra", stale, "api", "authoritative"),
      validateModel("gpt-6-astra", stale, "api"),
    ]) {
      expect(check.status).toBe("rejected");
      expect(check.message).toBe(
        'model "gpt-6-astra" is not in the harness\'s live model inventory ' +
          "(gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2)",
      );
    }
    for (const check of [
      validateModel("gpt-6-astra", [], "api", "authoritative"),
      validateModel("gpt-6-astra", [], "api"),
    ]) {
      expect(check.status).toBe("rejected");
      expect(check.message).toBe(
        "this harness cannot verify models (no live model inventory); repair the live " +
          "account/auth route or use the harness default (omit the model)",
      );
    }
  });
});

describe("model inventory credential routes", () => {
  it("keeps legacy enumeration and queries scoped producers only on their declared routes", () => {
    const adapter = { models: async () => [] };
    expect(hasModelInventoryForRoute(adapter, undefined, "api_key")).toBe(true);
    expect(hasModelInventoryForRoute(adapter, ["local_session"], null)).toBe(false);
    expect(hasModelInventoryForRoute(adapter, ["local_session"], "local_session")).toBe(true);
    expect(hasModelInventoryForRoute(adapter, ["local_session"], "api_key")).toBe(false);
    expect(hasModelInventoryForRoute({}, ["local_session"], "local_session")).toBe(false);
  });
});
