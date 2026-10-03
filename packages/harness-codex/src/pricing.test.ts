import { afterEach, describe, expect, it } from "vitest";
import { estimateCodexCostUsd, priceForModel } from "./pricing.js";

const ENV_KEYS = [
  "CLAUDEXOR_CODEX_PRICE_INPUT",
  "CLAUDEXOR_CODEX_PRICE_OUTPUT",
  "CLAUDEXOR_CODEX_PRICE_CACHED",
] as const;

describe("codex pricing", () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("estimates cost from token usage and explicitly configured rates", () => {
    process.env.CLAUDEXOR_CODEX_PRICE_INPUT = "1.25";
    process.env.CLAUDEXOR_CODEX_PRICE_OUTPUT = "10";
    const usd = estimateCodexCostUsd("gpt-5-codex", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    // 1M input * $1.25/M + 1M output * $10/M = 11.25
    expect(usd).toBeCloseTo(11.25, 5);
  });

  it("returns undefined when there are no token counts (never fabricate cost)", () => {
    expect(estimateCodexCostUsd("gpt-5-codex", {})).toBeUndefined();
    expect(
      estimateCodexCostUsd("gpt-5-codex", { input_tokens: 0, output_tokens: 0 }),
    ).toBeUndefined();
  });

  it("does not double-count cached tokens (cached is a subset of input)", () => {
    process.env.CLAUDEXOR_CODEX_PRICE_INPUT = "1.25";
    process.env.CLAUDEXOR_CODEX_PRICE_CACHED = "0.125";
    // input 1M total, 400k of it cached. non-cached 600k * $1.25/M + cached 400k * $0.125/M = 0.75 + 0.05.
    const usd = estimateCodexCostUsd("gpt-5-codex", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cached_input_tokens: 400_000,
    });
    expect(usd).toBeCloseTo(0.8, 8);
    // The buggy double-count would have charged 1M*1.25/M + 400k*0.125/M = 1.30.
    expect(usd).not.toBeCloseTo(1.3, 5);
  });

  it("clamps cached tokens that exceed input", () => {
    process.env.CLAUDEXOR_CODEX_PRICE_CACHED = "0.125";
    const usd = estimateCodexCostUsd("gpt-5-codex", {
      input_tokens: 100,
      output_tokens: 0,
      cached_input_tokens: 1_000_000,
    });
    // cached clamped to 100 -> non-cached 0; cost = 100 cached tokens * $0.125/M.
    expect(usd).toBeCloseTo((100 / 1e6) * 0.125, 10);
  });

  it("honors env price overrides", () => {
    process.env.CLAUDEXOR_CODEX_PRICE_INPUT = "2";
    process.env.CLAUDEXOR_CODEX_PRICE_OUTPUT = "20";
    const usd = estimateCodexCostUsd("gpt-5-codex", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(22, 5);
  });

  it.each(["gpt-6-astra", "gpt-5.6-sol", "gpt-5-codex", "future-mini"])(
    "keeps %s cost unknown without configured rates",
    (model) => {
      expect(priceForModel(model)).toEqual({
        input: undefined,
        output: undefined,
        cached: undefined,
      });
      expect(
        estimateCodexCostUsd(model, { input_tokens: 1000, output_tokens: 10 }),
      ).toBeUndefined();
    },
  );

  it("requires a cached-input rate only when cached tokens were used", () => {
    process.env.CLAUDEXOR_CODEX_PRICE_INPUT = "2";
    expect(estimateCodexCostUsd("gpt-6-astra", { input_tokens: 1000 })).toBeCloseTo(0.002);
    expect(
      estimateCodexCostUsd("gpt-6-astra", { input_tokens: 1000, cached_input_tokens: 100 }),
    ).toBeUndefined();
  });

  it.each(["", "-1", "2USD", "NaN", "Infinity"])("rejects invalid configured rate %s", (rate) => {
    process.env.CLAUDEXOR_CODEX_PRICE_INPUT = rate;
    expect(estimateCodexCostUsd("gpt-6-astra", { input_tokens: 1000 })).toBeUndefined();
  });
});
