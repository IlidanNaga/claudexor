import { RuntimeConcurrencyCaps, type GlobalConfig } from "@claudexor/schema";
import { ConfigParseError } from "./config-error.js";

const envKeys = {
  max_concurrent: "CLAUDEXOR_MAX_CONCURRENT",
  max_parallel_candidates: "CLAUDEXOR_MAX_PARALLEL_CANDIDATES",
  max_deep_scan_width: "CLAUDEXOR_MAX_DEEP_SCAN_WIDTH",
  max_council_members: "CLAUDEXOR_MAX_COUNCIL_MEMBERS",
} as const;

export function concurrencyEnv(): Partial<RuntimeConcurrencyCaps> {
  const out: Partial<RuntimeConcurrencyCaps> = {};
  for (const key of Object.keys(envKeys) as Array<keyof RuntimeConcurrencyCaps>) {
    const name = envKeys[key];
    const raw = process.env[name];
    if (raw === undefined) continue;
    const parsed = RuntimeConcurrencyCaps.shape[key].safeParse(Number(raw));
    if (!parsed.success) throw new ConfigParseError(`env:${name}`, parsed.error);
    out[key] = parsed.data;
  }
  return out;
}

/** Unrelated settings writes must not add new keys that old engines reject.
 * Preserve explicit YAML values, including values equal to today's defaults. */
export function omitImplicitConcurrency(config: GlobalConfig, original: unknown) {
  const raw = original as { runtime?: Record<string, unknown> } | null;
  const runtime: Partial<GlobalConfig["runtime"]> = { ...config.runtime };
  const defaults = RuntimeConcurrencyCaps.parse({});
  for (const key of Object.keys(defaults) as Array<keyof RuntimeConcurrencyCaps>) {
    if (!Object.hasOwn(raw?.runtime ?? {}, key) && runtime[key] === defaults[key])
      delete runtime[key];
  }
  return { ...config, runtime };
}
