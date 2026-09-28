import { describe, expect, it } from "vitest";
import {
  assertCouncilWidth,
  buildCouncilProjection,
  councilDegradationNote,
  councilDraftRelPath,
  councilMergePrompt,
  resolveCouncilWidth,
} from "./council.js";

describe("resolveCouncilWidth", () => {
  it("defaults to distinct available harnesses capped at 3", () => {
    expect(resolveCouncilWidth(undefined, 5)).toEqual({
      requested: 3,
      members: 3,
      degraded: false,
    });
    expect(resolveCouncilWidth(undefined, 2)).toEqual({
      requested: 2,
      members: 2,
      degraded: false,
    });
  });
  it("honors an explicit n, capping members by availability and disclosing degradation", () => {
    expect(resolveCouncilWidth(4, 4)).toEqual({ requested: 4, members: 4, degraded: false });
    // requested more than available -> capped + degraded (never duplicate a lane).
    expect(resolveCouncilWidth(4, 2)).toEqual({ requested: 4, members: 2, degraded: true });
    expect(resolveCouncilWidth(9, 12, 10)).toEqual({ requested: 9, members: 9, degraded: false });
    expect(() => resolveCouncilWidth(12, 12, 10)).toThrow(/exceeds the startup-frozen cap 10/);
    expect(resolveCouncilWidth(9, 8, 10)).toEqual({ requested: 9, members: 8, degraded: true });
  });
});

describe("assertCouncilWidth", () => {
  it("accepts the configured boundary and rejects only explicit invalid or over-cap widths", () => {
    expect(() => assertCouncilWidth(undefined, 2)).not.toThrow();
    expect(() => assertCouncilWidth(2, 2)).not.toThrow();
    expect(() => assertCouncilWidth(24, 24)).not.toThrow();
    expect(() => assertCouncilWidth(25, 24)).toThrow(/exceeds the startup-frozen cap 24/);
    for (const width of [0, 1, 2.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertCouncilWidth(width, 24)).toThrow(/safe integer of at least 2/);
    }
  });
});

describe("councilDraftRelPath", () => {
  it("names a file-backed draft per harness", () => {
    expect(councilDraftRelPath("claude")).toBe("council/draft-claude.md");
  });
});

describe("councilMergePrompt", () => {
  it("points at draft FILES by absolute path and keeps the tagged Open Questions block", () => {
    const prompt = councilMergePrompt("build X", [
      {
        attemptId: "p01",
        harnessId: "claude",
        absPath: "/runs/r1/council/draft-claude.md",
        evidencePath: "/runs/r1/attempts/p01/council-input.yaml",
        unverified: false,
        error: null,
      },
      {
        attemptId: "p02",
        harnessId: "codex",
        absPath: "/runs/r1/council/draft-codex.md",
        evidencePath: "/runs/r1/attempts/p02/council-input.yaml",
        unverified: true,
        error: "contradictory report",
      },
    ]);
    expect(prompt).toContain("/runs/r1/council/draft-claude.md");
    expect(prompt).toContain("/runs/r1/council/draft-codex.md");
    // The full draft text is never embedded — only pointer lines.
    expect(prompt).toContain("## Open Questions");
    expect(prompt).toContain("[single]");
    expect(prompt).toContain("build X");
    expect(prompt).toContain("codex (UNVERIFIED)");
    expect(prompt).toContain("/runs/r1/attempts/p02/council-input.yaml");
    expect(prompt).toContain("Original error: contradictory report");
  });
});

describe("buildCouncilProjection", () => {
  it("marks the merger 'merged', survivors 'drafted', and failures 'failed'", () => {
    const projection = buildCouncilProjection({
      requested: 3,
      members: [
        { harnessId: "claude", role: "primary", drafted: true, error: null },
        { harnessId: "codex", role: "member", drafted: true, error: null },
        { harnessId: "cursor", role: "member", drafted: false, error: "boom" },
      ],
      mergedBy: "claude",
    });
    expect(projection.drafted).toBe(2);
    expect(projection.degraded).toBe(true);
    expect(projection.mergedBy).toBe("claude");
    expect(projection.members.map((m) => m.status)).toEqual(["merged", "drafted", "failed"]);
    expect(projection.members[2]?.error).toBe("boom");
  });
});

describe("councilDegradationNote", () => {
  it("is empty at full width and names failures when degraded", () => {
    const full = buildCouncilProjection({
      requested: 2,
      members: [
        { harnessId: "claude", role: "primary", drafted: true, error: null },
        { harnessId: "codex", role: "member", drafted: true, error: null },
      ],
      mergedBy: "claude",
    });
    expect(councilDegradationNote(full)).toBe("");
    const degraded = buildCouncilProjection({
      requested: 3,
      members: [
        { harnessId: "claude", role: "primary", drafted: true, error: null },
        { harnessId: "codex", role: "member", drafted: false, error: "boom" },
      ],
      mergedBy: "claude",
    });
    expect(councilDegradationNote(degraded)).toContain("degraded to 1 of 3");
    expect(councilDegradationNote(degraded)).toContain("codex");
  });
});
