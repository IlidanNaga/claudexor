import { describe, expect, it } from "vitest";
import type {
  CredentialProfile,
  ModelSubstitutionObservation,
  QuotaSnapshot,
} from "@claudexor/schema";
import { GlobalConfig } from "@claudexor/schema";
import { rankAccountPool, selectFromAccountPool } from "./account-pool.js";

function row(id: string, overrides: Partial<CredentialProfile> = {}): CredentialProfile {
  return {
    profile_id: id,
    harness_id: "claude",
    display_name: id,
    credential_kind: "config_dir_login",
    isolation_locator: `/tmp/claudexor-test/profiles/claude-${id}`,
    secret_ref: null,
    enabled: true,
    created_at: null,
    ...overrides,
  };
}

function snapshot(
  subjectId: string,
  usedRatio: number,
  options: { freshness?: "fresh" | "stale"; resetsAt?: string | null; model?: string } = {},
): QuotaSnapshot {
  return {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subjectId,
    },
    constraints: [
      {
        id: "five_hour",
        label: "5 hour",
        used_ratio: usedRatio,
        window_seconds: 18_000,
        resets_at: options.resetsAt ?? null,
        cooldown_until: null,
        ...(options.model ? { applies_to_models: [options.model] } : {}),
      },
    ],
    source: "claude_oauth_usage",
    observed_at: "2026-08-18T00:00:00Z",
    freshness: options.freshness ?? "fresh",
  } as QuotaSnapshot;
}

const baseArgs = {
  harnessId: "claude",
  headroomThreshold: 0.9,
  model: null as string | null,
};

describe("account pool ranking (unified model, D-U1 + K.5)", () => {
  it("orders known fresh headroom descending, then unknown, then exhausted", () => {
    const registry = [row("a"), row("b"), row("c"), row("d")];
    const ranked = rankAccountPool({
      ...baseArgs,
      registry,
      snapshots: [
        snapshot("a", 0.5), // headroom 0.5
        snapshot("b", 0.1), // headroom 0.9 — best known
        snapshot("d", 0.95), // exhausted (>= 0.9 threshold)
        // c: no evidence → unknown
      ],
      readyProfileIds: new Set(["a", "b", "c", "d"]),
    });
    expect(ranked.map((c) => c.profile.profile_id)).toEqual(["b", "a", "c", "d"]);
    expect(ranked.map((c) => c.verdict.kind)).toEqual([
      "fresh_headroom",
      "fresh_headroom",
      "unknown",
      "exhausted",
    ]);
  });

  it("ranks a row under an OBSERVED live cooldown exhausted with its release instant (A4)", () => {
    // STALE on purpose: the registry keeps an aged snapshot alive exactly
    // because its cooldown still extends into the future — a reactive
    // vendor-limit cooldown is absolute clock truth, and selecting the row
    // would burn an attempt rediscovering the limit.
    const FUTURE = "2099-01-01T00:00:00.000Z";
    const cooling: QuotaSnapshot = {
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "a",
      },
      constraints: [
        {
          id: "cooldown",
          label: "Cooldown",
          used_ratio: null,
          window_seconds: null,
          resets_at: null,
          cooldown_until: FUTURE,
        },
      ],
      source: "claude_api_retry",
      observed_at: "2026-08-17T00:00:00Z",
      freshness: "stale",
    } as QuotaSnapshot;
    const ranked = rankAccountPool({
      ...baseArgs,
      registry: [row("a"), row("b")],
      snapshots: [cooling],
      readyProfileIds: new Set(["a", "b"]),
    });
    expect(ranked.map((c) => [c.profile.profile_id, c.verdict.kind])).toEqual([
      ["b", "unknown"],
      ["a", "exhausted"],
    ]);
    const selection = selectFromAccountPool({
      ...baseArgs,
      registry: [row("a"), row("b")],
      snapshots: [cooling],
      readyProfileIds: new Set(["a", "b"]),
    });
    expect(selection.outcome === "selected" && selection.candidate.profile.profile_id).toBe("b");
  });

  it("never ranks STALE quota as known headroom (D3: stale cannot authorize routing)", () => {
    const registry = [row("fresh-low"), row("stale-high")];
    const ranked = rankAccountPool({
      ...baseArgs,
      registry,
      snapshots: [
        snapshot("fresh-low", 0.8), // fresh, headroom 0.2
        snapshot("stale-high", 0.0, { freshness: "stale" }), // stale — ignored
      ],
      readyProfileIds: new Set(["fresh-low", "stale-high"]),
    });
    // Known-positive fresh evidence outranks a stale reading even though the
    // stale reading claims a full window.
    expect(ranked.map((c) => c.profile.profile_id)).toEqual(["fresh-low", "stale-high"]);
    expect(ranked[1]?.verdict.kind).toBe("unknown");
  });

  it("breaks ties deterministically by profile id", () => {
    const registry = [row("zeta"), row("alpha"), row("mid")];
    const ranked = rankAccountPool({
      ...baseArgs,
      registry,
      snapshots: [],
      readyProfileIds: new Set(["zeta", "alpha", "mid"]),
    });
    expect(ranked.map((c) => c.profile.profile_id)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("excludes disabled rows, foreign harnesses, api_key rows, and not-ready rows", () => {
    const registry = [
      row("ready"),
      row("disabled", { enabled: false }),
      row("foreign", { harness_id: "codex" }),
      row("paid", {
        credential_kind: "api_key",
        isolation_locator: null,
        secret_ref: "anthropic:paid",
      }),
      row("not-ready"),
    ];
    const ranked = rankAccountPool({
      ...baseArgs,
      registry,
      snapshots: [],
      readyProfileIds: new Set(["ready", "disabled", "foreign", "paid"]),
    });
    expect(ranked.map((c) => c.profile.profile_id)).toEqual(["ready"]);
  });

  it("ranks only model-applicable fresh quota for the requested model", () => {
    const registry = [row("scoped"), row("other")];
    const ranked = rankAccountPool({
      ...baseArgs,
      model: "claude-fable-5",
      registry,
      snapshots: [
        snapshot("scoped", 0.2, { model: "claude-fable-5" }),
        snapshot("other", 0.1, { model: "some-other-model" }), // not applicable → unknown
      ],
      readyProfileIds: new Set(["scoped", "other"]),
    });
    expect(ranked.map((c) => c.profile.profile_id)).toEqual(["scoped", "other"]);
    expect(ranked[1]?.verdict.kind).toBe("unknown");
  });
});

describe("model-substitution ordering (INV-135: ordered last, never excluded)", () => {
  const MODEL = "model-a";
  const substituted = (
    profileId: string,
    observedAt: string,
    over: Partial<ModelSubstitutionObservation> = {},
  ): ModelSubstitutionObservation => ({
    harness_id: "claude",
    profile_id: profileId,
    requested_model: MODEL,
    served_model: "model-b",
    observed_at: observedAt,
    expires_at: "2099-01-01T00:00:00.000Z",
    ...over,
  });
  const pool = (ids: string[], usedRatios: Record<string, number> = {}) => ({
    ...baseArgs,
    model: MODEL,
    registry: ids.map((id) => row(id)),
    snapshots: Object.entries(usedRatios).map(([id, used]) => snapshot(id, used)),
    readyProfileIds: new Set(ids),
  });
  const order = (args: Parameters<typeof rankAccountPool>[0]) =>
    rankAccountPool(args).map((c) => c.profile.profile_id);

  it("ranks a marked row after every other selectable row, whatever its headroom", () => {
    const args = pool(["best", "low", "unknown"], { best: 0.1, low: 0.8 });
    expect(order(args)).toEqual(["best", "low", "unknown"]);
    expect(
      order({ ...args, substitutions: [substituted("best", "2026-09-20T10:00:00.000Z")] }),
    ).toEqual(["low", "unknown", "best"]);
  });

  it("orders a fully marked pool oldest observation first and still selects from it", () => {
    const args = {
      ...pool(["a", "b", "c"], { a: 0.1, b: 0.5 }),
      substitutions: [
        substituted("a", "2026-09-20T10:20:00.000Z"),
        substituted("b", "2026-09-20T10:00:00.000Z"),
        substituted("c", "2026-09-20T10:10:00.000Z"),
      ],
    };
    expect(order(args)).toEqual(["b", "c", "a"]);
    expect(selectFromAccountPool(args)).toMatchObject({
      outcome: "selected",
      candidate: { profile: { profile_id: "b" }, verdict: { kind: "fresh_headroom" } },
    });
  });

  it("a refreshed observation re-orders: the account marked longest ago goes first", () => {
    const args = pool(["a", "b"], { a: 0.1, b: 0.5 });
    const old = substituted("b", "2026-09-20T10:00:00.000Z");
    expect(
      order({ ...args, substitutions: [substituted("a", "2026-09-20T10:05:00.000Z"), old] }),
    ).toEqual(["b", "a"]);
    // b substituted again: its refreshed observation is now the newest.
    expect(
      order({
        ...args,
        substitutions: [
          substituted("a", "2026-09-20T10:05:00.000Z"),
          substituted("b", "2026-09-20T10:06:00.000Z"),
        ],
      }),
    ).toEqual(["a", "b"]);
    // Equal instants fall back to today's order.
    expect(order({ ...args, substitutions: [substituted("a", old.observed_at), old] })).toEqual([
      "a",
      "b",
    ]);
  });

  it("keeps a marked singleton selectable and never makes a pool exhausted", () => {
    const only = {
      ...pool(["only"]),
      substitutions: [substituted("only", "2026-09-20T10:00:00.000Z")],
    };
    expect(selectFromAccountPool(only)).toMatchObject({
      outcome: "selected",
      candidate: { profile: { profile_id: "only" } },
    });
    const spent = {
      ...pool(["marked", "spent"], { spent: 0.99 }),
      substitutions: [
        substituted("marked", "2026-09-20T10:00:00.000Z"),
        substituted("spent", "2026-09-20T09:00:00.000Z"),
      ],
    };
    // An exhausted row keeps its place at the end whatever its mark says.
    expect(order(spent)).toEqual(["marked", "spent"]);
    expect(selectFromAccountPool(spent)).toMatchObject({
      outcome: "selected",
      candidate: { profile: { profile_id: "marked" } },
    });
  });

  it("ignores expired, foreign-harness and other-model observations", () => {
    const args = pool(["a", "b"], { a: 0.1, b: 0.5 });
    const at = "2026-09-20T10:00:00.000Z";
    for (const substitutions of [
      [substituted("a", "2020-01-01T00:00:00.000Z", { expires_at: "2020-01-01T00:30:00.000Z" })],
      [substituted("a", at, { harness_id: "codex" })],
      [substituted("a", at, { requested_model: "model-z" })],
      [],
    ])
      expect(order({ ...args, substitutions })).toEqual(["a", "b"]);
    // No requested model (a catalog read) matches no observation.
    expect(order({ ...args, model: null, substitutions: [substituted("a", at)] })).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("account pool selection", () => {
  it.each([
    [0.9, "selected"],
    [0.95, "selected"],
    [0.99, "selected"],
    [1, "exhausted"],
  ] as const)("default policy at %s usage leaves the pool %s", (usedRatio, outcome) => {
    const policy = GlobalConfig.parse({ harnesses: { claude: {} } }).harnesses["claude"]!
      .profile_policy;
    const selection = selectFromAccountPool({
      ...baseArgs,
      registry: [row("last-account")],
      snapshots: [snapshot("last-account", usedRatio)],
      readyProfileIds: new Set(["last-account"]),
      headroomThreshold: policy.headroom_threshold,
    });
    expect(selection.outcome).toBe(outcome);
  });

  it("selects the best candidate and never an exhausted row", () => {
    const registry = [row("spent"), row("open")];
    const selection = selectFromAccountPool({
      ...baseArgs,
      registry,
      snapshots: [snapshot("spent", 0.99), snapshot("open", 0.3)],
      readyProfileIds: new Set(["spent", "open"]),
    });
    expect(selection).toMatchObject({
      outcome: "selected",
      candidate: { profile: { profile_id: "open" } },
    });
  });

  it("reports exhaustion with the earliest known reset when every ready row is spent", () => {
    const registry = [row("a"), row("b")];
    const selection = selectFromAccountPool({
      ...baseArgs,
      registry,
      snapshots: [
        snapshot("a", 0.95, { resetsAt: "2026-08-18T12:00:00Z" }),
        snapshot("b", 0.99, { resetsAt: "2026-08-18T06:00:00Z" }),
      ],
      readyProfileIds: new Set(["a", "b"]),
    });
    expect(selection).toEqual({ outcome: "exhausted", resets_at: "2026-08-18T06:00:00Z" });
  });

  it("reports an empty pool when nothing is ready", () => {
    const selection = selectFromAccountPool({
      ...baseArgs,
      registry: [row("cold")],
      snapshots: [],
      readyProfileIds: new Set(),
    });
    expect(selection).toEqual({ outcome: "empty", resets_at: null });
  });
});
