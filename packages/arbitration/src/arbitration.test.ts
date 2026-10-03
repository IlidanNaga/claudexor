import { describe, expect, it } from "vitest";
import type { GateResult } from "@claudexor/schema";
import { type CandidateEvidence, arbitrate } from "./arbitration.js";

function gate(passed: boolean): GateResult {
  return {
    id: "tests",
    command: "pnpm test",
    exit_code: passed ? 0 : 1,
    status: passed ? "passed" : "failed",
    duration_ms: 1,
    required: true,
    stdout_tail: null,
    stderr_tail: null,
    output_truncated: false,
  };
}

function candidate(label: string, over: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    attemptId: label,
    label,
    gates: [gate(true)],
    acceptanceCovered: ["AC-1"],
    acceptanceTotal: 1,
    findings: [],
    testsPassed: 10,
    testsTotal: 10,
    finalReviewClean: true,
    reviewVerified: true,
    diffSize: 50,
    diffBytes: 50,
    ...over,
  };
}

describe("arbitrate", () => {
  it("keeps unreviewed apply permission separate from verification evidence and legacy absence", () => {
    const unreviewed = candidate("A", {
      reviewVerified: false,
      finalReviewClean: false,
      gates: [],
      testsPassed: 0,
      testsTotal: 0,
    });
    const off = arbitrate([unreviewed], { reviewRequested: false }).decision;
    expect(off.facts).toMatchObject({ review: "not_run", review_requested: false });
    expect(off.apply_recommendation).toBe("apply");
    expect(off.verification_basis).toBe("none");
    expect(arbitrate([unreviewed]).decision.apply_recommendation).toBe("human_review");
    expect(arbitrate([unreviewed], { reviewRequested: true }).decision.apply_recommendation).toBe(
      "human_review",
    );
    const checked = arbitrate(
      [candidate("A", { reviewVerified: false, finalReviewClean: false })],
      { reviewRequested: false },
    ).decision;
    expect(checked.verification_basis).toBe("deterministic_checks");
  });
  it("ranks a green candidate over one failing a required gate", () => {
    const a = candidate("A");
    const b = candidate("B", { gates: [gate(false)] });
    const res = arbitrate([b, a]);
    expect(res.ranking[0]?.label).toBe("A");
    expect(res.decision.winner).toBe("A");
    expect(res.decision.facts.lifecycle).toBe("succeeded");
    expect(res.decision.facts.review).toBe("approved");
    expect(res.decision.facts.checks).toBe("passed");
    expect(res.decision.apply_recommendation).toBe("apply");
    expect(res.decision.verification_basis).toBe("both");
  });

  it("discloses an exact tie (winner by route order, not silently decisive)", () => {
    const a = candidate("A");
    const b = candidate("B"); // identical evidence on every axis
    const res = arbitrate([a, b]);
    expect(res.ranking[0]?.label).toBe("A"); // route order
    expect(
      res.decision.final_checks.some((c) => c.includes("tie: winner chosen by route order")),
    ).toBe(true);
    // A genuinely better candidate is NOT flagged as a tie.
    const c = candidate("C", { diffSize: 10 });
    const res2 = arbitrate([c, candidate("D", { diffSize: 999 })]);
    expect(res2.decision.final_checks.some((x) => x.includes("tie:"))).toBe(false);
  });

  it("labels zero configured required gates as n/a, never passed", () => {
    const result = arbitrate([candidate("A", { gates: [] })]);
    expect(result.decision.final_checks).toContain("required gates n/a (none configured)");
    expect(result.decision.final_checks).not.toContain("required gates passed");
  });

  it("prefers higher acceptance coverage", () => {
    const a = candidate("A", { acceptanceCovered: ["AC-1", "AC-2"], acceptanceTotal: 2 });
    const b = candidate("B", { acceptanceCovered: ["AC-1"], acceptanceTotal: 2 });
    expect(arbitrate([b, a]).ranking[0]?.label).toBe("A");
  });

  it("uses tool warning count as a tie-breaker after hard evidence axes", () => {
    const clean = candidate("clean", { toolWarningsCount: 0 });
    const noisy = candidate("noisy", { toolWarningsCount: 4 });
    const res = arbitrate([noisy, clean]);
    expect(res.ranking[0]?.label).toBe("clean");
    expect(res.decision.winner).toBe("clean");
  });

  it("surfaces a failed required gate on the CHECKS axis (never masked)", () => {
    // D18: a failed real gate yields checks=failed on a succeeded lifecycle (a
    // needs-decision terminal) — the old lattice masked it as not_converged.
    const a = candidate("A", { gates: [gate(false)] });
    const res = arbitrate([a]);
    expect(res.decision.facts.lifecycle).toBe("succeeded");
    expect(res.decision.facts.checks).toBe("failed");
    expect(res.decision.facts.reason).toBe("checks_failed");
    expect(res.decision.apply_recommendation).not.toBe("apply");
  });

  it("carries the settled cash + subscription-valuation split onto the decision (QA-010b)", () => {
    // Native-subscription route: cash is exactly 0 but ~$0.40 of valuation was
    // used (candidate + reviewer panel). Both must reach the decision record.
    const res = arbitrate([candidate("A")], {
      spendUsd: 0,
      estimatedSpend: true,
      cashUsd: 0,
      valuationUsd: 0.3982,
    });
    expect(res.decision.budget_summary.spend_usd).toBe(0);
    expect(res.decision.budget_summary.cash_usd).toBe(0);
    expect(res.decision.budget_summary.valuation_usd).toBeCloseTo(0.3982, 4);
  });

  it("marks empty diffs as no_changes on a succeeded lifecycle instead of a clean apply", () => {
    const res = arbitrate([candidate("A", { diffBytes: 0, diffSize: 0 })]);
    expect(res.decision.facts.lifecycle).toBe("succeeded");
    expect(res.decision.facts.noChanges).toBe(true);
    expect(res.decision.facts.reason).toBe("no_changes");
    expect(res.decision.apply_recommendation).not.toBe("apply");
  });

  it("does not mask harness failures as no_op when the diff is empty", () => {
    // A zero-configured-gate errored run: the producer appends the synthetic
    // harness pseudo-gate for lifecycle, but computes the test counts from the
    // configured gates only (0/0, not the polluted 0/1).
    const res = arbitrate([
      candidate("A", {
        diffBytes: 0,
        diffSize: 0,
        gates: [
          {
            id: "harness",
            status: "failed",
            required: true,
            command: "codex",
            exit_code: 1,
            duration_ms: 1,
            stdout_tail: null,
            stderr_tail: null,
            output_truncated: false,
          },
        ],
        testsPassed: 0,
        testsTotal: 0,
        finalReviewClean: false,
      }),
    ]);
    expect(res.decision.facts.lifecycle).toBe("failed");
    expect(res.decision.facts.reason).toBe("harness_failed");
    expect(res.decision.apply_recommendation).not.toBe("apply");
    // The pseudo-gate is lifecycle evidence, never a configured check: no
    // resurrected "tests=0% / required gates FAILED / gates 0/1".
    expect(res.decision.facts.checks).toBe("not_configured");
    expect(res.decision.why_winner).toContain("tests=n/a");
    expect(res.decision.final_checks).toContain("required gates n/a (none configured)");
  });

  it("keeps checks not_configured even when a producer repollutes the counts with the pseudo-gate", () => {
    // Guard for the configuredGates() seam: a legacy/foreign producer that
    // counted the synthetic harness row into testsTotal must still not flip
    // the checks axis to failed — the gate rows are the ground truth.
    const res = arbitrate([
      candidate("A", {
        diffBytes: 0,
        diffSize: 0,
        gates: [
          {
            id: "harness",
            status: "failed",
            required: true,
            command: "codex",
            exit_code: 1,
            duration_ms: 1,
            stdout_tail: null,
            stderr_tail: null,
            output_truncated: false,
          },
        ],
        testsPassed: 0,
        testsTotal: 1,
        finalReviewClean: false,
      }),
    ]);
    expect(res.decision.facts.lifecycle).toBe("failed");
    expect(res.decision.facts.checks).toBe("not_configured");
    expect(res.decision.final_checks).toContain("required gates n/a (none configured)");
  });

  it("fails checks for a gate-less candidate with failing raw tests (base behavior kept)", () => {
    // sol counterexample 1: dropping the raw testsTotal>0 disjunct turned
    // 0/10 failing tests with no gates into checks=not_configured + apply.
    const res = arbitrate([candidate("A", { gates: [], testsPassed: 0, testsTotal: 10 })]);
    expect(res.decision.facts.checks).toBe("failed");
    expect(res.decision.apply_recommendation).not.toBe("apply");
  });

  it("keeps the checks axis on configured gates when the harness errored after a green gate", () => {
    // sol counterexample 2 / grok M1 / fable m: the augmented requiredOk must
    // not leak into checks — configured gate passed, harness errored: the
    // record stays self-consistent (labels and checks both configured-only),
    // lifecycle still carries the harness failure.
    const harnessRow = {
      id: "harness",
      status: "failed" as const,
      required: true,
      command: "codex",
      exit_code: 1,
      duration_ms: 1,
      stdout_tail: null,
      stderr_tail: null,
      output_truncated: false,
    };
    const res = arbitrate([
      candidate("A", { gates: [gate(true), harnessRow], testsPassed: 1, testsTotal: 1 }),
    ]);
    expect(res.decision.facts.lifecycle).toBe("failed");
    expect(res.decision.facts.reason).toBe("harness_failed");
    expect(res.decision.facts.checks).toBe("passed");
    expect(res.decision.final_checks.join(" ")).toContain("required gates passed");
    expect(res.decision.apply_recommendation).not.toBe("apply");
  });

  it("keeps existing test-axis ordering between errored candidates (raw counts rank)", () => {
    // sol counterexample 3: routing the RANKING fraction through configured
    // counts made 1/10 and 9/10 both rank 100% and the 1/10 candidate win.
    const harnessRow = {
      id: "harness",
      status: "failed" as const,
      required: true,
      command: "codex",
      exit_code: 1,
      duration_ms: 1,
      stdout_tail: null,
      stderr_tail: null,
      output_truncated: false,
    };
    const weak = candidate("weak", {
      gates: [gate(true), harnessRow],
      testsPassed: 1,
      testsTotal: 10,
      diffBytes: 1,
      diffSize: 1,
      finalReviewClean: false,
      reviewVerified: false,
    });
    const strong = candidate("strong", {
      gates: [gate(true), harnessRow],
      testsPassed: 9,
      testsTotal: 10,
      diffBytes: 500,
      diffSize: 500,
      finalReviewClean: false,
      reviewVerified: false,
    });
    const res = arbitrate([weak, strong]);
    expect(res.ranking[0]?.label).toBe("strong");
    // QA-028 on the ranking surface: the axis FORMAT explains the ordering
    // its VALUE produced (the configured label rendered both as 100%, leaving
    // decisive_axis unable to explain itself — final-lane finding).
    const scorecard = res.decision.ranking_scorecard ?? [];
    const fmt = (label: string) => scorecard.find((row) => row.label === label)?.axes?.tests ?? "";
    expect(fmt("strong")).toContain("90%");
    expect(fmt("weak")).toContain("10%");
  });

  it("adopts a no-gate run on a VERIFIED clean cross-family review, basis disclosed", () => {
    // No deterministic test gate, but the cross-family review is route-proof
    // verified and clean → applyable, recorded honestly as review-based.
    const res = arbitrate([candidate("A", { gates: [], testsPassed: 0, testsTotal: 0 })]);
    expect(res.decision.facts.lifecycle).toBe("succeeded");
    expect(res.decision.facts.review).toBe("approved");
    expect(res.decision.apply_recommendation).toBe("apply");
    expect(res.decision.verification_basis).toBe("cross_family_review");
  });

  it("reports cross_family_review (not both) when only a NON-required gate is present", () => {
    // A non-required/diagnostic gate is not deterministic verification; a clean
    // verified review backs this run, so the basis must be cross_family_review.
    const res = arbitrate([
      candidate("A", {
        testsPassed: 0,
        testsTotal: 0,
        gates: [
          {
            id: "lint",
            command: "lint",
            exit_code: 0,
            status: "passed",
            duration_ms: 1,
            required: false,
            stdout_tail: null,
            stderr_tail: null,
            output_truncated: false,
          },
        ],
      }),
    ]);
    expect(res.decision.facts.lifecycle).toBe("succeeded");
    expect(res.decision.verification_basis).toBe("cross_family_review");
  });

  it("keeps a no-gate run NOT-VERIFIED (checks not_configured, review not_run) when the review is not verified", () => {
    const res = arbitrate([
      candidate("A", { gates: [], testsPassed: 0, testsTotal: 0, reviewVerified: false }),
    ]);
    expect(res.decision.facts.lifecycle).toBe("succeeded");
    expect(res.decision.facts.checks).toBe("not_configured");
    expect(res.decision.facts.review).toBe("not_run");
    expect(res.decision.apply_recommendation).toBe("human_review");
    expect(res.decision.verification_basis).toBe("none");
  });

  it("marks a missing verified review as review not_run (checks stay honest) instead of a clean apply", () => {
    const res = arbitrate([candidate("A", { reviewVerified: false })]);
    expect(res.decision.facts.lifecycle).toBe("succeeded");
    expect(res.decision.facts.review).toBe("not_run");
    // The configured gates still passed — checks are reported honestly, never
    // masked behind the review axis (D18 lattice fix).
    expect(res.decision.facts.checks).toBe("passed");
    expect(res.decision.apply_recommendation).toBe("human_review");
  });

  it("[INV-116:blockers-visible / D18] accepted blockers with NO gates always surface review=blocked (never invisible)", () => {
    // The ex-"ungated" collapse dies: accepted review blockers must ALWAYS be
    // visible on the review axis, even from an unverified panel with no checks.
    const res = arbitrate([
      candidate("A", {
        gates: [],
        testsPassed: 0,
        testsTotal: 0,
        reviewVerified: false,
        findings: [
          {
            id: "f1",
            severity: "BLOCK",
            status: "accepted",
            claim: "an accepted blocking risk",
            evidence: { files: [{ path: "src/x.ts" }], diff_hunks: [], commands: [], logs: [] },
          } as unknown as CandidateEvidence["findings"][number],
        ],
      }),
    ]);
    expect(res.decision.facts.lifecycle).toBe("succeeded");
    expect(res.decision.facts.review).toBe("blocked");
    expect(res.decision.facts.checks).toBe("not_configured");
    expect(res.decision.facts.reason).toBe("review_blocked");
    expect(res.decision.apply_recommendation).not.toBe("apply");
  });

  it("handles no candidates", () => {
    const res = arbitrate([]);
    expect(res.decision.winner).toBeNull();
    expect(res.decision.facts.lifecycle).toBe("failed");
    expect(res.decision.facts.reason).toBe("harness_failed");
  });

  it("records spend honestly and never labels estimated spend as exact", () => {
    const a = candidate("A");
    const exact = arbitrate([a], { spendUsd: 0.5 });
    expect(exact.decision.budget_summary.spend_usd).toBeCloseTo(0.5);
    expect(exact.decision.budget_summary.estimated).toBe(false);

    const estimated = arbitrate([a], { spendUsd: 0.5, estimatedSpend: true });
    expect(estimated.decision.budget_summary.spend_usd).toBeCloseTo(0.5);
    expect(estimated.decision.budget_summary.estimated).toBe(true);
  });

  it("labels zero configured tests as n/a, never a vacuous 100%", () => {
    const res = arbitrate([candidate("A", { gates: [], testsPassed: 0, testsTotal: 0 })]);
    expect(res.decision.why_winner).toContain("tests=n/a");
    expect(res.decision.why_winner).not.toContain("tests=100%");
  });

  it("treats zero tests as zero test evidence in ranking (not a perfect score)", () => {
    const withTests = candidate("A", { testsPassed: 10, testsTotal: 10 });
    const noTests = candidate("B", { testsPassed: 0, testsTotal: 0 });
    const res = arbitrate([noTests, withTests]);
    expect(res.ranking[0]?.label).toBe("A");
    expect(res.decision.why_winner).toContain("tests=100%");
  });

  // QA-028: the decision record must carry the full per-candidate score tuple
  // (every compared axis with values) and name the DECISIVE axis; a win on a
  // tie-breaker axis must never collapse to "narrowly behind on tie-breakers".
  describe("score-tuple transparency (QA-028)", () => {
    // Real QA-028 fixture: leading axes tie, tool warnings differ (A=1, B=0).
    const fixture = () => {
      const a = candidate("A", { toolWarningsCount: 1, diffSize: 10, costUsd: 0.0377655 });
      const b = candidate("B", { toolWarningsCount: 0, diffSize: 10, costUsd: 0 });
      return arbitrate([a, b], { spendUsd: 0 });
    };

    it("names the decisive axis with both candidates' values", () => {
      const res = fixture();
      expect(res.decision.winner).toBe("B");
      expect(res.decision.decisive_axis).not.toBeNull();
      expect(res.decision.decisive_axis?.key).toBe("tool_warnings");
      expect(res.decision.decisive_axis?.winner_value).toBe("0");
      expect(res.decision.decisive_axis?.runner_up_value).toBe("1");
    });

    it("lists every ranking axis key in registry order", () => {
      const res = fixture();
      expect(res.decision.score_axes).toEqual([
        "required_gates",
        "acceptance_coverage",
        "blockers",
        "tests",
        "clean_review",
        "tool_warnings",
        "diff_size",
        "cost",
      ]);
    });

    it("carries a full per-candidate scorecard with every axis value", () => {
      const res = fixture();
      const b = res.decision.ranking_scorecard.find((c) => c.attempt_id === "B");
      const a = res.decision.ranking_scorecard.find((c) => c.attempt_id === "A");
      expect(res.decision.ranking_scorecard.map((c) => c.attempt_id)).toEqual(["B", "A"]);
      for (const key of res.decision.score_axes) {
        expect(a?.axes[key]).toBeDefined();
        expect(b?.axes[key]).toBeDefined();
      }
      expect(b?.axes["tool_warnings"]).toBe("0");
      expect(a?.axes["tool_warnings"]).toBe("1");
    });

    it("why_not_others names the decisive tie-breaker axis, never bare prose", () => {
      const res = fixture();
      const reason = res.decision.why_not_others["A"] ?? "";
      expect(reason).toContain("tool_warnings");
      expect(reason).toContain("1");
      expect(reason).not.toContain("narrowly behind on tie-breakers");
    });

    it("why_winner names the decisive axis", () => {
      const res = fixture();
      expect(res.decision.why_winner).toContain("tool_warnings");
    });

    it("pairwise serializes every ranking axis, including the decisive one", () => {
      const res = fixture();
      const pair = res.decision.winner ? res.pairwise[0] : undefined;
      expect(pair).toBeDefined();
      for (const key of res.decision.score_axes) {
        expect(pair?.criteria[key]).toBeDefined();
      }
      expect(pair?.criteria["tool_warnings"]?.winner).not.toBe("tie");
    });

    it("an exact tie has no decisive axis (route-order disclosure stays)", () => {
      const res = arbitrate([candidate("A"), candidate("B")]);
      expect(res.decision.decisive_axis).toBeNull();
      expect(
        res.decision.final_checks.some((c) => c.includes("tie: winner chosen by route order")),
      ).toBe(true);
    });
  });
});

describe("required_gates axis format matches its ranking predicate", () => {
  it("an errored zero-gate loser formats distinguishably from a healthy zero-gate winner", () => {
    const base = {
      acceptanceCovered: [],
      acceptanceTotal: 0,
      findings: [],
      testsPassed: 0,
      testsTotal: 0,
      finalReviewClean: true,
      diffSize: 1,
    };
    const healthy = { ...base, attemptId: "B", label: "Candidate B", gates: [] };
    const errored = {
      ...base,
      attemptId: "A",
      label: "Candidate A",
      gates: [
        {
          id: "harness",
          command: "harness",
          exit_code: 1,
          status: "failed" as const,
          duration_ms: 0,
          required: true,
          stdout_tail: null,
          stderr_tail: null,
          output_truncated: false,
        },
      ],
    };
    const record = arbitrate([errored, healthy]).decision;
    const axes = record.ranking_scorecard.map((row) => ({
      id: row.attempt_id,
      gates: row.axes["required_gates"],
    }));
    const winner = axes.find((a) => a.id === "B");
    const loser = axes.find((a) => a.id === "A");
    // QA-028: the axis value and label on ONE surface may never disagree —
    // and the decisive-axis disclosure must be able to EXPLAIN the pick, so
    // the two candidates' formats must differ when their values do.
    expect(winner?.gates).not.toBe(loser?.gates);
    expect(loser?.gates).toContain("FAILED");
    expect(loser?.gates).toContain("harness errored");
  });
});
