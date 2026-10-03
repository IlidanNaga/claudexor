import { describe, expect, it } from "vitest";
import type { CandidateEvidence } from "@claudexor/arbitration";
import {
  DEEP_SCAN_REDUCER_MARKER,
  buildDeepScanReducerPrompt,
  buildSynthesisPlan,
  decideSynthesis,
} from "./index.js";

describe("buildDeepScanReducerPrompt", () => {
  it("opens with the reducer marker and points at scout report files by absolute path (never inlines them)", () => {
    const prompt = buildDeepScanReducerPrompt("map auth", [
      { attemptId: "a01", harnessId: "codex", absPath: "/runs/r1/findings/a01.md" },
      { attemptId: "a02", harnessId: "claude", absPath: "/runs/r1/findings/a02.md" },
    ]);
    expect(prompt).toContain(DEEP_SCAN_REDUCER_MARKER);
    // Reports ride a FILE (absolute path pointer), never argv.
    expect(prompt).toContain("/runs/r1/findings/a01.md");
    expect(prompt).toContain("/runs/r1/findings/a02.md");
    // The instructed merge contract: dedup, surface disagreements w/ attribution,
    // preserve omissions, stay read-only.
    expect(prompt.toLowerCase()).toContain("deduplicate");
    expect(prompt.toLowerCase()).toContain("disagree");
    expect(prompt.toLowerCase()).toContain("read-only");
  });
});

function cand(label: string, over: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    attemptId: label,
    label,
    gates: [
      {
        id: "t",
        command: "t",
        exit_code: 0,
        status: "passed",
        duration_ms: 1,
        required: true,
        stdout_tail: null,
        stderr_tail: null,
        output_truncated: false,
      },
    ],
    acceptanceCovered: ["AC-1"],
    acceptanceTotal: 1,
    findings: [],
    testsPassed: 10,
    testsTotal: 10,
    finalReviewClean: true,
    diffSize: 50,
    ...over,
  };
}

describe("decideSynthesis", () => {
  it("never / <2 candidates / always", () => {
    expect(decideSynthesis([cand("A"), cand("B")], "never").synthesize).toBe(false);
    expect(decideSynthesis([cand("A")], "auto").synthesize).toBe(false);
    expect(decideSynthesis([cand("A"), cand("B")], "always").synthesize).toBe(true);
  });

  it("does NOT synthesize when one candidate clearly dominates", () => {
    const a = cand("A", { testsPassed: 10, testsTotal: 10, diffSize: 10 });
    const b = cand("B", { testsPassed: 8, testsTotal: 10, diffSize: 100 });
    expect(decideSynthesis([a, b], "auto").synthesize).toBe(false);
  });

  it("auto does NOT synthesize on best-of-2 (n<3): it just picks the winner", () => {
    // Same complementary inputs that DO synthesize at n>=3 (below).
    const a = cand("A", { testsPassed: 10, testsTotal: 10, diffSize: 100 });
    const b = cand("B", { testsPassed: 8, testsTotal: 10, diffSize: 10 });
    const d = decideSynthesis([a, b], "auto");
    expect(d.synthesize).toBe(false);
    expect(d.reason).toContain("best-of-2");
  });

  it("synthesizes on complementary strengths at n>=3 (top wins tests, second is simpler)", () => {
    const a = cand("A", { testsPassed: 10, testsTotal: 10, diffSize: 100 });
    const b = cand("B", { testsPassed: 8, testsTotal: 10, diffSize: 10 });
    const c = cand("C", { testsPassed: 5, testsTotal: 10, diffSize: 200 });
    const d = decideSynthesis([a, b, c], "auto");
    expect(d.synthesize).toBe(true);
    expect(d.reason).toContain("complementary");
  });

  it("always still forces synthesis even on best-of-2", () => {
    expect(decideSynthesis([cand("A"), cand("B")], "always").synthesize).toBe(true);
  });

  it("an errored candidate (harness pseudo-gate only) is never a green complementary runner-up", () => {
    // Zero-configured-gate errored run: the configured-gates axis is vacuously
    // passing, so only the pseudo-gate marks the failure — a smaller diff from
    // it must not trigger synthesis against a clear winner.
    const a = cand("A", { testsPassed: 10, testsTotal: 10, diffSize: 100 });
    const errored = cand("B", {
      gates: [
        {
          id: "harness",
          command: "harness",
          exit_code: 1,
          status: "failed",
          duration_ms: 0,
          required: true,
          stdout_tail: null,
          stderr_tail: null,
          output_truncated: false,
        },
      ],
      testsPassed: 0,
      testsTotal: 0,
      finalReviewClean: false,
      diffSize: 10,
    });
    const c = cand("C", {
      gates: [
        {
          id: "t",
          command: "t",
          exit_code: 1,
          status: "failed",
          duration_ms: 1,
          required: true,
          stdout_tail: null,
          stderr_tail: null,
          output_truncated: false,
        },
      ],
      // Ranked BELOW the errored candidate (acceptance 0 < 1) so the errored
      // run really is the runner-up the complementary guard evaluates —
      // otherwise this test never reaches the branch it names.
      acceptanceCovered: [],
      testsPassed: 0,
      testsTotal: 10,
      diffSize: 200,
    });
    const d = decideSynthesis([a, errored, c], "auto");
    expect(d.synthesize).toBe(false);
    expect(d.sources).toEqual(["A"]);
  });

  it("an errored candidate with passed configured gates never outranks a healthy one", () => {
    // Gates can pass and THEN the harness errors. The ranking predicate
    // deliberately reads the AUGMENTED gates (the harness pseudo-gate demotes
    // the errored run), so the healthy runner-up becomes the top candidate —
    // any "clearly passes all gates and review" suppression then honestly
    // describes the HEALTHY winner, never the failed run.
    const erroredTop = cand("A", {
      gates: [
        {
          id: "t",
          command: "t",
          exit_code: 0,
          status: "passed",
          duration_ms: 1,
          required: true,
          stdout_tail: null,
          stderr_tail: null,
          output_truncated: false,
        },
        {
          id: "harness",
          command: "harness",
          exit_code: 1,
          status: "failed",
          duration_ms: 0,
          required: true,
          stdout_tail: null,
          stderr_tail: null,
          output_truncated: false,
        },
      ],
      diffSize: 10,
    });
    const b = cand("B", { testsPassed: 5, testsTotal: 10, diffSize: 200 });
    // C ranks below the errored candidate (acceptance 0), so the errored run
    // is the actual runner-up the suppression predicate inspects.
    const c = cand("C", { acceptanceCovered: [], testsPassed: 4, testsTotal: 10, diffSize: 300 });
    const d = decideSynthesis([erroredTop, b, c], "auto");
    // The clear-winner suppression may fire — but only about the healthy
    // candidate: the errored run must not be the source it names.
    if (!d.synthesize) {
      expect(d.sources).not.toContain("A");
      expect(d.sources).toContain("B");
    } else {
      expect(d.reason).toContain("no clear winner");
    }
  });

  it("builds a plan: base = overall winner, borrow tests from the best-tests candidate", () => {
    // A wins overall (required gate passes), but B has stronger tests despite a failing gate.
    const a = cand("A", { testsPassed: 8, testsTotal: 10 });
    const b = cand("B", {
      gates: [
        {
          id: "t",
          command: "t",
          exit_code: 1,
          status: "failed",
          duration_ms: 1,
          required: true,
          stdout_tail: null,
          stderr_tail: null,
          output_truncated: false,
        },
      ],
      testsPassed: 10,
      testsTotal: 10,
    });
    const plan = buildSynthesisPlan([a, b]);
    expect(plan.baseFrom).toBe("A");
    expect(plan.borrowTestsFrom).toBe("B");
  });
});
