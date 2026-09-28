import { describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessRunSpec, CredentialProfile } from "@claudexor/schema";
import {
  assertRouteModelsAllowed,
  runModelGovernedRoute,
  type ModelGovernedRoute,
} from "./modelGovernance.js";

describe("runModelGovernedRoute", () => {
  it("uses the exact spawn profile/state and refuses before adapter.run", async () => {
    const profile: CredentialProfile = {
      profile_id: "rotated",
      harness_id: "cursor",
      display_name: "Rotated",
      credential_kind: "api_key",
      isolation_locator: null,
      secret_ref: "cursor:rotated",
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const models = vi.fn(async () => []);
    const run = vi.fn((_spec: HarnessRunSpec) =>
      (async function* () {
        yield* [];
      })(),
    );
    const adapter = { id: "cursor", models, run } as unknown as HarnessAdapter;
    const routed: ModelGovernedRoute = {
      adapter,
      knownModels: [],
      authRouteEstimate: "local_session",
      quotaAdmission: { profile: null },
      settings: null,
    };
    const spec = HarnessRunSpec.parse({
      session_id: "ses-model-governance",
      intent: "audit",
      prompt: "review",
      cwd: "/repo/attempt",
      env: { HOME: "/state/attempt" },
      auth_preference: "api_key",
      credential_profile: profile,
      model_hint: "profile-only-model",
    });

    const consume = async (): Promise<void> => {
      for await (const _event of runModelGovernedRoute(routed, spec)) {
        // Rejection occurs before any event can be emitted.
      }
    };
    await expect(consume()).rejects.toThrow(
      /profile 'rotated' supplied this live inventory \(\d+ models\); inspect that profile's own vendor model list/,
    );
    expect(models).toHaveBeenCalledWith({
      cwd: "/repo/attempt",
      env: { HOME: "/state/attempt" },
      authPreference: "api_key",
      credentialProfile: profile,
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("assertRouteModelsAllowed", () => {
  it("uses the exact scoped env and invents no auth preference without a named profile", async () => {
    const seen: unknown[] = [];
    const adapter = {
      id: "cursor",
      models: async (spec: unknown) => {
        seen.push(spec);
        return [{ id: "profile-less-model", label: "Profile-less model" }];
      },
    } as unknown as HarnessAdapter;
    const routed: ModelGovernedRoute = {
      adapter,
      knownModels: [],
      authRouteEstimate: "local_session",
      quotaAdmission: { profile: null },
      settings: { defaultModel: "profile-less-model", fallbackModel: null },
    };
    const env = { HOME: "/tmp/scoped-model-home" };

    await assertRouteModelsAllowed([routed], undefined, "/repo", () => env);

    // The admission route is NOT replayed as an auth preference here: the spawn
    // will resolve `auto` itself, and a preflight that asked a different
    // question than the run would be answering about a different account.
    expect(seen).toEqual([{ cwd: "/repo", env }]);
  });

  it("defers a fallback model until its own profile/state reaches the spawn guard", async () => {
    const primaryProfile: CredentialProfile = {
      profile_id: "primary",
      harness_id: "cursor",
      display_name: "Primary",
      credential_kind: "config_dir_login",
      isolation_locator: "/profiles/primary",
      secret_ref: null,
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const fallbackProfile: CredentialProfile = {
      ...primaryProfile,
      profile_id: "fallback",
      display_name: "Fallback",
      isolation_locator: "/profiles/fallback",
    };
    const run = vi.fn((_spec: HarnessRunSpec) =>
      (async function* () {
        yield* [];
      })(),
    );
    const models = vi.fn(async (spec?: { credentialProfile?: CredentialProfile | null }) => {
      return spec?.credentialProfile?.profile_id === "fallback"
        ? [{ id: "fallback-model", label: "Fallback" }]
        : [{ id: "primary-model", label: "Primary" }];
    });
    const adapter = { id: "cursor", models, run } as unknown as HarnessAdapter;
    const routed: ModelGovernedRoute = {
      adapter,
      knownModels: [],
      authRouteEstimate: "local_session",
      quotaAdmission: { profile: primaryProfile },
      settings: { defaultModel: "primary-model", fallbackModel: "fallback-model" },
    };

    await assertRouteModelsAllowed([routed], undefined, "/repo", () => ({
      HOME: "/primary-state",
    }));

    const fallbackSpec = HarnessRunSpec.parse({
      session_id: "ses-fallback-model-governance",
      intent: "audit",
      prompt: "review",
      cwd: "/repo/fallback-attempt",
      env: { HOME: "/fallback-state" },
      auth_preference: "subscription",
      credential_profile: fallbackProfile,
      model_hint: "fallback-model",
    });
    for await (const _event of runModelGovernedRoute(routed, fallbackSpec)) {
      // The profile-specific inventory admits the fallback before run.
    }

    expect(models).toHaveBeenNthCalledWith(1, {
      cwd: "/repo",
      env: { HOME: "/primary-state" },
      credentialProfile: primaryProfile,
    });
    expect(models).toHaveBeenNthCalledWith(2, {
      cwd: "/repo/fallback-attempt",
      env: { HOME: "/fallback-state" },
      authPreference: "subscription",
      credentialProfile: fallbackProfile,
    });
    expect(run).toHaveBeenCalledWith(fallbackSpec);
  });
});

describe("profile-less auto is answered as auto, never rewritten", () => {
  const autoAdapter = (
    id: string,
    modelSpecs: unknown[],
    runSpecs: HarnessRunSpec[],
  ): HarnessAdapter =>
    ({
      id,
      models: async (spec: unknown) => {
        modelSpecs.push(spec);
        return [{ id: "bound-model", label: "Bound" }];
      },
      run: (spec: HarnessRunSpec) =>
        (async function* () {
          runSpecs.push(spec);
          yield* [];
        })(),
    }) as unknown as HarnessAdapter;

  // Sol wave-4 P1/P2 counterexamples: the gate used to concretize the admitted
  // route into `subscription`/`api_key`. For a non-Cursor adapter that queried
  // a different inventory than its own spawn would use, and for Cursor it
  // silenced the `auth_switched/readiness_preferred` disclosure, which the
  // adapter emits ONLY while the received preference is still `auto`.
  it.each(["cursor", "generic"])(
    "%s: the inventory is asked with auto and the spawned spec is byte-identical",
    async (id) => {
      const modelSpecs: unknown[] = [];
      const runSpecs: HarnessRunSpec[] = [];
      const routed: ModelGovernedRoute = {
        adapter: autoAdapter(id, modelSpecs, runSpecs),
        knownModels: [],
        authRouteEstimate: id === "cursor" ? "local_session" : null,
        quotaAdmission: { profile: null },
        settings: null,
      };
      const spec = HarnessRunSpec.parse({
        session_id: `ses-auto-${id}`,
        intent: "audit",
        prompt: "review",
        cwd: "/repo",
        env: { HOME: "/state" },
        auth_preference: "auto",
        model_hint: "bound-model",
      });

      for await (const _event of runModelGovernedRoute(routed, spec)) {
        // The adapter emits no events in this contract test.
      }

      expect(modelSpecs).toEqual([
        { cwd: "/repo", env: { HOME: "/state" }, authPreference: "auto" },
      ]);
      expect(runSpecs).toEqual([spec]);
      expect(runSpecs[0]?.auth_preference).toBe("auto");
    },
  );

  it("an undecidable admission route no longer refuses a profile-less auto run", async () => {
    const modelSpecs: unknown[] = [];
    const runSpecs: HarnessRunSpec[] = [];
    const routed: ModelGovernedRoute = {
      adapter: autoAdapter("cursor", modelSpecs, runSpecs),
      knownModels: [],
      authRouteEstimate: null,
      quotaAdmission: { profile: null },
      settings: null,
    };
    const spec = HarnessRunSpec.parse({
      session_id: "ses-undecidable-route",
      intent: "audit",
      prompt: "review",
      cwd: "/repo",
      auth_preference: "auto",
      model_hint: "bound-model",
    });

    for await (const _event of runModelGovernedRoute(routed, spec)) {
      // The vendor, not this gate, is the authority on an `auto` route.
    }

    expect(runSpecs).toEqual([spec]);
  });

  it("the early gate leaves a non-Cursor automatic route alone as well", async () => {
    const seen: unknown[] = [];
    const routed: ModelGovernedRoute = {
      adapter: {
        id: "generic",
        models: async (spec: unknown) => {
          seen.push(spec);
          return [{ id: "generic-model", label: "Generic" }];
        },
      } as unknown as HarnessAdapter,
      knownModels: [],
      authRouteEstimate: null,
      quotaAdmission: { profile: null },
      settings: { defaultModel: "generic-model", fallbackModel: null },
    };

    await assertRouteModelsAllowed([routed], undefined, "/repo");

    expect(seen).toEqual([{ cwd: "/repo" }]);
  });
});

/**
 * The regression this change exists for. A codex `model/list` probe whose
 * remote fetch timed out answers with the CLI's bundled default list — live in
 * shape, stale in content — and nothing on the wire marks it. Under the old
 * strict gate that list refused `gpt-6-astra` on the very accounts that were
 * serving it, in under a second, for free, as an untyped failure. An advisory
 * inventory now forwards the explicit model and says once that it was unlisted.
 */
describe("advisory live inventory (absence is not proof)", () => {
  // The exact list observed in the live refusals: astra dropped from the front,
  // gpt-5.2 appended at the back — a previous generation of the same list.
  const STALE = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"];
  const NOTE =
    "model \"gpt-6-astra\" is not in this account's listed models; this harness's list " +
    "cannot prove a model is absent, so the request is forwarded to the vendor";

  const codexish = (
    absence: "authoritative" | "advisory" | undefined,
    list: readonly string[],
    runSpecs: HarnessRunSpec[] = [],
  ): ModelGovernedRoute => ({
    adapter: {
      id: "codex",
      models: async () => list.map((id) => ({ id, label: null })),
      run: (spec: HarnessRunSpec) =>
        (async function* () {
          runSpecs.push(spec);
          yield* [];
        })(),
    } as unknown as HarnessAdapter,
    knownModels: ["gpt-6-astra"],
    modelInventory: {
      model_inventory_routes: ["local_session"],
      ...(absence ? { model_inventory_absence: absence } : {}),
    },
    authRouteEstimate: "local_session",
    quotaAdmission: { profile: null },
    settings: { defaultModel: "gpt-6-astra", fallbackModel: null },
  });

  const astraSpec = (session: string): HarnessRunSpec =>
    HarnessRunSpec.parse({
      session_id: session,
      intent: "audit",
      prompt: "review",
      cwd: "/repo",
      env: { HOME: "/state" },
      auth_preference: "subscription",
      model_hint: "gpt-6-astra",
    });

  it("admits the unlisted model at BOTH gates, discloses once, and spawns the spec byte-identical", async () => {
    const runSpecs: HarnessRunSpec[] = [];
    const routed = codexish("advisory", STALE, runSpecs);
    // Preflight stays SILENT (it has no event stream; the spawn gate speaks).
    await assertRouteModelsAllowed([routed], undefined, "/repo");
    const spec = astraSpec("ses-advisory-stale");
    const events = [];
    for await (const event of runModelGovernedRoute(routed, spec)) events.push(event);
    const disclosures = events.filter((event) => event.type === "status");
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]?.text).toBe(NOTE);
    expect(disclosures[0]?.session_id).toBe("ses-advisory-stale");
    // Never a second list: the manifest (which HAS astra) is not substituted,
    // and the spec the adapter receives is the one the caller asked for.
    expect(runSpecs).toEqual([spec]);
    expect(runSpecs[0]?.model_hint).toBe("gpt-6-astra");
  });

  it("forwards an EMPTY live answer too, with the note naming that case", async () => {
    const runSpecs: HarnessRunSpec[] = [];
    const routed = codexish("advisory", [], runSpecs);
    await assertRouteModelsAllowed([routed], undefined, "/repo");
    const events = [];
    for await (const event of runModelGovernedRoute(routed, astraSpec("ses-advisory-empty")))
      events.push(event);
    expect(events.filter((event) => event.type === "status").map((event) => event.text)).toEqual([
      "the harness returned no model list; this harness's list cannot prove a model is " +
        "absent, so the request is forwarded to the vendor",
    ]);
    expect(runSpecs).toHaveLength(1);
  });

  it("says nothing at all when the live list DOES carry the model", async () => {
    const routed = codexish("advisory", [...STALE, "gpt-6-astra"]);
    const events = [];
    for await (const event of runModelGovernedRoute(routed, astraSpec("ses-advisory-listed")))
      events.push(event);
    expect(events).toEqual([]);
  });

  it("an AUTHORITATIVE adapter still refuses the same list with today's exact text", async () => {
    for (const absence of ["authoritative", undefined] as const) {
      const runSpecs: HarnessRunSpec[] = [];
      const routed = codexish(absence, STALE, runSpecs);
      const consume = async () => {
        for await (const _event of runModelGovernedRoute(routed, astraSpec("ses-strict"))) {
          /* the refusal precedes every event */
        }
      };
      await expect(consume()).rejects.toThrow(
        "harness 'codex' refused model 'gpt-6-astra' (truth source: api): " +
          'model "gpt-6-astra" is not in the harness\'s live model inventory ' +
          "(gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2); " +
          "run `claudexor models --harness codex`",
      );
      await expect(assertRouteModelsAllowed([routed], undefined, "/repo")).rejects.toThrow(
        /refused model 'gpt-6-astra'/,
      );
      expect(runSpecs).toEqual([]);
    }
  });

  it("an authoritative adapter still refuses an EMPTY inventory with today's exact text", async () => {
    const routed = codexish("authoritative", []);
    await expect(assertRouteModelsAllowed([routed], undefined, "/repo")).rejects.toThrow(
      "harness 'codex' refused model 'gpt-6-astra' (truth source: api): this harness cannot " +
        "verify models (no live model inventory); repair the live account/auth route or use " +
        "the harness default (omit the model); run `claudexor models --harness codex`",
    );
  });

  it("carries the advisory declaration to MANIFEST truth on another route (the harness declares, not the list)", async () => {
    // An api_key route reads the manifest hints. Those are one day's memory of
    // the same vendor menu, so the harness's declaration governs them too:
    // advisory forwards the miss; authoritative refuses it with today's text.
    // No list is swapped for another either way (the live list is never read).
    const profile = CredentialProfile.parse({
      profile_id: "api",
      harness_id: "codex",
      display_name: "API",
      credential_kind: "api_key",
      secret_ref: "openai:api",
    });
    const forwarded: ModelGovernedRoute = {
      ...codexish("advisory", STALE),
      knownModels: [{ id: "manifest-only", routes: ["api_key"] }],
      quotaAdmission: { profile },
    };
    await expect(
      assertRouteModelsAllowed([forwarded], { codex: "gpt-6-astra" }, "/repo"),
    ).resolves.toBeUndefined();
    const refused: ModelGovernedRoute = {
      ...codexish("authoritative", STALE),
      knownModels: [{ id: "manifest-only", routes: ["api_key"] }],
      quotaAdmission: { profile },
    };
    await expect(
      assertRouteModelsAllowed([refused], { codex: "gpt-6-astra" }, "/repo"),
    ).rejects.toThrow(
      /truth source: manifest, route: api_key.*manifest known-model list \(manifest-only\)/,
    );
  });
});

describe("route-scoped live model producer", () => {
  it("admits the API-key manifest model at preflight and actual spawn without borrowing native inventory", async () => {
    const profile = CredentialProfile.parse({
      profile_id: "api-key",
      harness_id: "generic",
      display_name: "API",
      credential_kind: "api_key",
      secret_ref: "openai:api",
    });
    const models = vi.fn(async () => []);
    const run = vi.fn((_spec: HarnessRunSpec) =>
      (async function* () {
        yield* [];
      })(),
    );
    const routed: ModelGovernedRoute = {
      adapter: { id: "generic", models, run } as unknown as HarnessAdapter,
      knownModels: [{ id: "api-model", routes: ["api_key"] }],
      modelInventory: { model_inventory_routes: ["local_session"] },
      authRouteEstimate: "local_session",
      quotaAdmission: { profile },
      settings: { defaultModel: "api-model", fallbackModel: null },
    };
    await assertRouteModelsAllowed([routed], undefined, "/repo");
    const spec = HarnessRunSpec.parse({
      session_id: "api-model",
      intent: "audit",
      prompt: "test",
      cwd: "/repo",
      credential_profile: profile,
      model_hint: "api-model",
    });
    for await (const _event of runModelGovernedRoute(routed, spec)) {
      /* consume */
    }
    expect(models).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(spec);
    await expect(
      assertRouteModelsAllowed([routed], { generic: "native-model" }, "/repo"),
    ).rejects.toThrow(/truth source: manifest, route: api_key/);
    const nativeProfile = CredentialProfile.parse({
      ...profile,
      credential_kind: "config_dir_login",
      secret_ref: null,
      isolation_locator: "/profiles/native",
    });
    const native = {
      ...routed,
      knownModels: ["api-model"],
      quotaAdmission: { profile: nativeProfile },
    };
    await expect(assertRouteModelsAllowed([native], undefined, "/repo")).rejects.toThrow(
      /truth source: api.*cannot verify models/,
    );
    expect(models).toHaveBeenCalledWith({ cwd: "/repo", credentialProfile: nativeProfile });
  });
});
