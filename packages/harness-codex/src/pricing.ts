/**
 * Codex reports token usage, not a dollar cost. Only explicitly configured
 * CLAUDEXOR_CODEX_PRICE_INPUT / _OUTPUT / _CACHED rates (USD per 1M tokens)
 * may produce an estimate. Without a rate for every used token category,
 * cost remains unknown; the budget owner handles subscription cash separately.
 */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
}

interface Price {
  input: number | undefined;
  output: number | undefined;
  cached: number | undefined;
}

function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function priceForModel(_model: string | null | undefined): Price {
  return {
    input: envNum("CLAUDEXOR_CODEX_PRICE_INPUT"),
    output: envNum("CLAUDEXOR_CODEX_PRICE_OUTPUT"),
    cached: envNum("CLAUDEXOR_CODEX_PRICE_CACHED"),
  };
}

/**
 * Estimate USD cost from token usage. Returns undefined when no usable token
 * counts are present (so we never fabricate a zero/spurious cost).
 */
export function estimateCodexCostUsd(
  model: string | null | undefined,
  usage: TokenUsage,
): number | undefined {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  // Codex usage reports cached_input_tokens as a SUBSET of input_tokens (the
  // total prompt), matching OpenAI usage semantics. Clamp defensively.
  const cached = Math.min(usage.cached_input_tokens ?? 0, input);
  if (input === 0 && output === 0 && cached === 0) return undefined;
  const p = priceForModel(model);
  // Bill the non-cached prompt portion at the input rate and the cached subset
  // at the (cheaper) cached rate. Previously the cached tokens were billed
  // twice (once inside input_tokens at the full input rate, once at the cached
  // rate), over-reporting codex spend by up to ~4x on cache-heavy turns.
  const nonCached = Math.max(0, input - cached);
  if (
    (nonCached > 0 && p.input === undefined) ||
    (output > 0 && p.output === undefined) ||
    (cached > 0 && p.cached === undefined)
  )
    return undefined;
  const usd =
    (nonCached / 1e6) * (p.input ?? 0) +
    (output / 1e6) * (p.output ?? 0) +
    (cached / 1e6) * (p.cached ?? 0);
  return Number.isFinite(usd) ? usd : undefined;
}
