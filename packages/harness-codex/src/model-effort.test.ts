import { expect, it, vi } from "vitest";
import canonical from "../../schema/fixtures/effort-resolution.json" with { type: "json" };
import {
  ControlModelCatalogResponse,
  CredentialProfile,
  ModelCallRequest,
  ModelCallResult,
} from "@claudexor/schema";
import { createCodexModelAdapter } from "./model.js";

function fixture(levels: string[] | null = ["low", "max"], observed?: string) {
  const dispatch = vi.fn(async () => {});
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method !== "POST")
      return Response.json({
        models: [
          {
            slug: "target",
            ...(levels ? { supported_reasoning_levels: levels.map((effort) => ({ effort })) } : {}),
          },
          {
            slug: "sibling",
            supported_reasoning_levels: [
              "none",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
              "ultra",
            ].map((effort) => ({ effort })),
          },
        ],
      });
    expect(dispatch).toHaveBeenCalledTimes(1);
    return new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          model: "target",
          output: [],
          ...(observed ? { reasoning: { effort: observed } } : {}),
        },
      })}\n\n`,
    );
  });
  const adapter = createCodexModelAdapter({
    fetch,
    now: () => 1900000000000,
    clientVersion: async () => ({ version: "0.156.1", source: "verified_transport" }),
    readAuthFile: async () =>
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: "fixture",
          id_token: `fixture.${Buffer.from('{"sub":"fixture-user"}').toString("base64url")}.signature`,
          access_token: `fixture.${Buffer.from(JSON.stringify({ exp: 2100000000 })).toString("base64url")}.signature`,
        },
      }),
  });
  const request = ModelCallRequest.parse({
    source: "codex",
    model: "target",
    account: { mode: "pin", profileId: "fixture" },
    messages: [{ role: "user", content: "test" }],
  });
  const context = {
    profile: CredentialProfile.parse({
      profile_id: "fixture",
      harness_id: "codex",
      display_name: "Fixture",
      credential_kind: "config_dir_login",
      isolation_locator: `${process.env.CLAUDEXOR_CONFIG_DIR}/fixture`,
    }),
    signal: new AbortController().signal,
    onDispatch: dispatch,
  };
  return { fetch, dispatch, request, context, adapter };
}

it.each([
  ["xhigh", ["low", "max"], "low", "downward"],
  ["none", ["high", "max"], "high", "floor"],
  ["future-native", ["future-native"], "future-native", "exact"],
  ["Future.Native/2027", ["Future.Native/2027"], "Future.Native/2027", "exact"],
  ["none", ["none", "high"], "none", "exact"],
  ["xhigh", [], null, "omitted"],
] as const)(
  "resolves %s in the exact account catalog before its only POST",
  async (requested, levels, submitted, resolution) => {
    const f = fixture([...levels]);
    const request = { ...f.request, options: { reasoningEffort: requested } };
    const frozen = JSON.stringify(request);
    const result = await f.adapter.invoke(request, f.context);
    expect(JSON.stringify(request)).toBe(frozen);
    expect(result.outcome).toBe("completed");
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    const body = JSON.parse(await new Response(f.fetch.mock.calls[1]![1]!.body).text());
    expect(body.reasoning?.effort ?? null).toBe(submitted);
    expect(ModelCallResult.parse(result)).toMatchObject({
      effortResolution: { requested, submitted, resolution, source: "account_catalog" },
    });
    expect(result.appliedOptions.reasoningEffort).toBeUndefined();
  },
);

it("keeps a provider echo separate from submission", async () => {
  const f = fixture(["low", "max"], "max");
  const result = await f.adapter.invoke(
    { ...f.request, options: { reasoningEffort: "xhigh" } },
    f.context,
  );
  expect(result).toMatchObject({
    effortResolution: { requested: "xhigh", submitted: "low", observed: "max" },
  });
});

it("refuses unrankable requests without dispatch, generation, or a zero-cost claim", async () => {
  const f = fixture();
  const result = await f.adapter.invoke(
    { ...f.request, options: { reasoningEffort: "invented" } },
    f.context,
  );
  expect(result.problem?.code).toBe("unsupported_parameter");
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(result.cost.cashUsd).toBeNull();
  expect(result).toMatchObject({
    effortResolution: { requested: "invented", submitted: null, resolution: "rejected" },
  });
});

it("pins the exact additive receipt for embedding consumers", async () => {
  const f = fixture(["low", "xhigh"]);
  const result = await f.adapter.invoke(
    { ...f.request, options: { reasoningEffort: "ultra" } },
    f.context,
  );
  expect(result.effortResolution).toEqual(canonical);
});

it.each([{ levels: null }, { levels: [] }])(
  "retains missing versus empty effort metadata through catalog reuse: $levels",
  async ({ levels }) => {
    const f = fixture(levels);
    const catalog = ControlModelCatalogResponse.parse(await f.adapter.catalog(f.context));
    const result = await f.adapter.invoke(
      { ...f.request, options: { reasoningEffort: "xhigh" } },
      { ...f.context, catalog },
    );
    expect(result.outcome).toBe("completed");
    expect(result.effortResolution).toMatchObject({
      requested: "xhigh",
      submitted: null,
      resolution: levels ? "omitted" : "unverifiable",
      observed: null,
      observedSource: null,
    });
    expect(f.fetch.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST"]);
  },
);
