import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialProfile, HarnessRunSpec } from "@claudexor/schema";
import { codexExecArgs, createCodexAdapter, canonicalCodexProfileHome } from "./index.js";
import { readModelListEfforts } from "./effort-probe.js";
import {
  codexProcessingCapability,
  prepareCodexProcessing,
  observeCodexProcessing,
  codexConfiguredTier,
  legacyCodexProcessing,
} from "./processing.js";

const capability = codexProcessingCapability(
  {
    service_tiers: [
      { id: "priority", name: "Fast" },
      { id: "flex", name: "Economy" },
    ],
  },
  "fixture",
);

describe("Codex processing preserves exact native intent", () => {
  it("enumerates the actual selected account without borrowing another account's Fast tier", async () => {
    const home = join(process.env.CLAUDEXOR_CONFIG_DIR!, "processing-catalog-one");
    const profile = CredentialProfile.parse({
      profile_id: "processing-one",
      harness_id: "codex",
      display_name: "One",
      credential_kind: "config_dir_login",
      isolation_locator: home,
    });
    const adapter = createCodexAdapter({
      probeEfforts: async (_bin, env) =>
        readModelListEfforts([
          {
            id: "account-model",
            displayName: "Account Model",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            serviceTiers:
              env?.CODEX_HOME === canonicalCodexProfileHome(home) ? [{ id: "priority" }] : [],
          },
        ]),
    });
    const first = await adapter.models?.({ cwd: "/repo", credentialProfile: profile });
    expect(first?.[0]).toMatchObject({
      id: "account-model",
      label: "Account Model",
      processing: { modes: ["standard", "fast"], observedAt: null },
    });
    const second = await adapter.models?.({
      cwd: "/repo",
      credentialProfile: {
        ...profile,
        profile_id: "processing-two",
        isolation_locator: home + "-two",
      },
    });
    expect(second?.[0].processing?.modes).toEqual(["standard"]);
  });
  it("reads only an explicit native root setting and does not reapply it for legacy clients", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-processing-test-"));
    try {
      writeFileSync(
        join(home, "config.toml"),
        'service_tier = "fast" # native intent\n[unrelated]\nservice_tier = "default"\n',
      );
      const receipt = legacyCodexProcessing(codexConfiguredTier(home));
      expect(receipt).toMatchObject({
        requested: null,
        submitted: "fast",
        reason: "native_explicit",
      });
      const spec = HarnessRunSpec.parse({
        session_id: "s",
        intent: "implement",
        prompt: "test",
        cwd: "/repo",
        access: "workspace_write",
        processing: receipt,
      });
      expect(codexExecArgs(spec).some((arg) => arg.startsWith("service_tier="))).toBe(false);
      writeFileSync(join(home, "config.toml"), '[unrelated]\nservice_tier = "fast"\n');
      expect(codexConfiguredTier(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("keeps omission separate from explicit ordinary service", () => {
    expect(prepareCodexProcessing(undefined)).toBeUndefined();
    expect(prepareCodexProcessing("standard", capability)).toMatchObject({
      requested: "standard",
      submittedNative: "default",
      observed: "unknown",
    });
  });
  it("uses only advertised premium modes and falls back without inventing Fast", () => {
    expect(prepareCodexProcessing("fast", capability)?.submittedNative).toBe("priority");
    expect(prepareCodexProcessing("economy", capability)?.submittedNative).toBe("flex");
    expect(
      prepareCodexProcessing(
        "economy",
        codexProcessingCapability({ service_tiers: [{ id: "priority" }] }, "fixture"),
      )?.submittedNative,
    ).toBe("default");
    expect(prepareCodexProcessing("fast")?.submittedNative).toBe("default");
  });
  it("retains deliberate native override even under Standard and observes separately", () => {
    const receipt = prepareCodexProcessing("standard", capability, "priority")!;
    expect(receipt).toMatchObject({
      submitted: "fast",
      reason: "native_explicit",
      observed: "unknown",
    });
    expect(observeCodexProcessing(receipt, "default")).toMatchObject({
      submitted: "fast",
      observed: "standard",
      observedNative: ["default"],
    });
  });
  it("passes captured native mode on fresh and resumed sessions without changing effort", () => {
    for (const resume_session_id of [null, "native-session"]) {
      const spec = HarnessRunSpec.parse({
        session_id: "s",
        intent: "implement",
        prompt: "test",
        cwd: "/repo",
        access: "workspace_write",
        model_hint: "gpt-5.6-sol",
        effort_hint: "high",
        resume_session_id,
        processing: prepareCodexProcessing("standard", capability),
      });
      const args = codexExecArgs(spec);
      expect(args).toContain('service_tier="default"');
      expect(args).toContain('model_reasoning_effort="high"');
      expect(args).toContain("gpt-5.6-sol");
    }
  });
  it("retains per-model service tiers in the existing account effort probe", () => {
    const catalog = readModelListEfforts([
      {
        id: "one",
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        serviceTiers: [{ id: "priority" }],
      },
      { id: "two", supportedReasoningEfforts: [{ reasoningEffort: "high" }], serviceTiers: [] },
    ]);
    expect(catalog?.processing?.one.modes).toEqual(["standard", "fast"]);
    expect(catalog?.processing?.two.modes).toEqual(["standard"]);
  });
});

describe("Codex inventory route isolation", () => {
  it("declares native-only inventory and never reads native auth for an API-key query", async () => {
    const probeEfforts = vi.fn(async () => null);
    const adapter = createCodexAdapter({
      detectVersion: async () => "0.0.0-fixture",
      hasApiKey: () => true,
      probeLogin: async () => ({ authed: false, method: "logged_out", probeError: null }),
      probeEfforts,
    });
    const manifest = await adapter.discover();
    expect(manifest.capabilities.model_inventory_routes).toEqual(["local_session"]);
    expect(manifest.capabilities.known_models).toContain("gpt-6-astra");
    probeEfforts.mockClear();
    const profile = CredentialProfile.parse({
      profile_id: "managed-api",
      harness_id: "codex",
      display_name: "API",
      credential_kind: "api_key",
      secret_ref: "openai:fixture-api",
    });
    expect(await adapter.models?.({ cwd: "/repo", credentialProfile: profile })).toEqual([]);
    expect(await adapter.models?.({ cwd: "/repo", authPreference: "api_key" })).toEqual([]);
    expect(probeEfforts).not.toHaveBeenCalled();
  });
});
