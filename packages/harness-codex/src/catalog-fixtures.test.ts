/**
 * The recorded catalog pair behind `CODEX_HTTP_CLIENT_VERSION` (issue #339):
 * the same account's `/backend-api/codex/models` read at the previous declared
 * version and at the verified one. Bumping the constant is a contract change
 * for every model listed at BOTH versions (efforts gate `unsupported_parameter`,
 * service tiers feed processing, `isDefault` drives fresh-install defaults
 * downstream), so the pair pins that shared rows stayed byte-identical and only
 * the newly floored models were added. Re-record both files with the next bump.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODEX_HTTP_CLIENT_VERSION } from "./http-client-version.js";
import { parseCodexModelCatalog } from "./model.js";

const PREVIOUS = "0.153.3";
const read = (version: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/models-http-${version}.json`, import.meta.url), "utf8"),
  );

describe(`Codex HTTP catalog at client_version ${PREVIOUS} vs ${CODEX_HTTP_CLIENT_VERSION}`, () => {
  const before = parseCodexModelCatalog(read(PREVIOUS));
  const after = parseCodexModelCatalog(read(CODEX_HTTP_CLIENT_VERSION));

  it("keeps every shared row identical (efforts, tiers, windows, modalities, default)", () => {
    const byId = new Map(after.map((entry) => [entry.id, entry]));
    for (const entry of before) {
      expect(byId.get(entry.id), `${entry.id} disappeared at ${CODEX_HTTP_CLIENT_VERSION}`).toEqual(
        entry,
      );
    }
  });

  it("only adds the models the backend floors at a newer client version, and keeps the default", () => {
    const added = after.filter((entry) => !before.some((old) => old.id === entry.id));
    expect(added.map((entry) => entry.id).sort()).toEqual(["gpt-6-luna", "gpt-6-sol"]);
    expect(before.find((entry) => entry.isDefault)?.id).toBe("gpt-6-astra");
    expect(after.find((entry) => entry.isDefault)?.id).toBe("gpt-6-astra");
    for (const entry of added) {
      expect(entry.contextWindow).toBe(272000);
      expect(entry.reasoningEfforts).toContain("xhigh");
    }
  });

  it("records the floor the backend applies, so the refusal can name it when the row is visible", () => {
    const raw = read(CODEX_HTTP_CLIENT_VERSION) as { models: Array<Record<string, unknown>> };
    const floors = Object.fromEntries(
      raw.models
        .filter((model) => ["gpt-6-sol", "gpt-6-luna"].includes(String(model.slug)))
        .map((model) => [model.slug, model.minimal_client_version]),
    );
    expect(floors).toEqual({ "gpt-6-sol": "0.155.0", "gpt-6-luna": "0.155.0" });
  });
});
