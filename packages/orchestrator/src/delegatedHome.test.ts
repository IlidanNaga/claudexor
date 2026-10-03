import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DelegatedEvidenceIncompleteError, DelegatedHomeUnavailableError } from "@claudexor/core";
import {
  DELIBERATE_NO_OUTER_BOUNDARY_REASON,
  RecordedAppliedAttemptFacts,
  WorkspaceEnvelope,
} from "@claudexor/schema";
import { ensureDir } from "@claudexor/util";
import { WorkspaceManager } from "@claudexor/workspace";
import {
  appliedAttemptFacts,
  appliedEvidenceComplete,
  assertDelegatedEvidence,
  outerBoundaryNotice,
  scopedHarnessHome,
} from "./delegatedHome.js";

function envelopeAt(base: string, repoRoot: string, inPlace: boolean): WorkspaceEnvelope {
  const homeDir = join(base, "home");
  ensureDir(homeDir);
  return WorkspaceEnvelope.parse({
    id: "env-1",
    task_id: "task-1",
    attempt_id: "a01",
    repo_root: repoRoot,
    base_ref: "HEAD",
    base_sha: null,
    worktree_path: inPlace ? repoRoot : join(base, "tree"),
    branch_name: inPlace ? "inplace" : "claudexor/task-1/a01",
    home_dir: homeDir,
    harness_config_dirs: {
      codex_home: join(homeDir, ".codex"),
      claude_config: join(homeDir, ".claude"),
    },
    policy_profile: "workspace_write",
    dirty_policy: "snapshot",
    created_at: new Date().toISOString(),
  });
}

describe("scopedHarnessHome", () => {
  const base = mkdtempSync(join(tmpdir(), "claudexor-delegated-home-"));
  const repoRoot = join(base, "repo");
  ensureDir(repoRoot);
  const wsm = new WorkspaceManager(repoRoot, { runtimeRoot: join(base, "runtime") });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("leaves an ordinary in-place attempt on the operator's native environment", () => {
    expect(scopedHarnessHome(wsm, envelopeAt(base, repoRoot, true), true, false)).toEqual({
      isolated: false,
      homeDir: null,
      outerBoundaryUnavailableReason: null,
    });
  });

  it("scopes isolated and delegated in-place attempts", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    const home = scopedHarnessHome(wsm, envelope, true, true);
    expect(home.isolated).toBe(true);
    expect(home.homeDir).toBe(envelope.home_dir);
    expect(home.env?.["HOME"]).toBe(envelope.home_dir);
    expect(home.env?.["CODEX_HOME"]).toBe(join(envelope.home_dir, ".codex"));
    expect(home.env?.["CLAUDE_CONFIG_DIR"]).toBe(join(envelope.home_dir, ".claude"));
    expect(home.env?.["XDG_CONFIG_HOME"]).toBe(join(envelope.home_dir, ".config"));
  });

  it("refuses a delegated attempt whose scoped home is absent", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    rmSync(envelope.home_dir, { recursive: true, force: true });
    expect(() => scopedHarnessHome(wsm, envelope, true, true)).toThrowError(
      DelegatedHomeUnavailableError,
    );
    expect(scopedHarnessHome(wsm, envelope, true, false).isolated).toBe(false);
  });
});

describe("delegated boundary disclosure", () => {
  const base = mkdtempSync(join(tmpdir(), "claudexor-delegated-disclosure-"));
  const repoRoot = join(base, "project");
  ensureDir(repoRoot);
  const wsm = new WorkspaceManager(repoRoot, { runtimeRoot: join(base, "runtime") });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("keeps native workspace_write and records deliberate no-outer-boundary evidence", () => {
    const home = scopedHarnessHome(
      wsm,
      envelopeAt(base, repoRoot, true),
      true,
      true,
      "workspace_write",
    );
    expect(home.outerBoundaryUnavailableReason).toBe(DELIBERATE_NO_OUTER_BOUNDARY_REASON);
    expect(appliedAttemptFacts(home, "workspace_write", "profile-a")).toMatchObject({
      access_applied: "workspace_write",
      credential_profile_applied: "profile-a",
      confinement_mechanism: null,
      confinement_profile_digest: null,
      confinement_verified_denied_path: null,
      confinement_unavailable_reason: DELIBERATE_NO_OUTER_BOUNDARY_REASON,
    });
  });

  it("does not add the disclosure to readonly or ordinary attempts", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    expect(
      scopedHarnessHome(wsm, envelope, true, true, "readonly").outerBoundaryUnavailableReason,
    ).toBeNull();
    expect(
      scopedHarnessHome(wsm, envelope, true, false, "workspace_write")
        .outerBoundaryUnavailableReason,
    ).toBeNull();
  });

  it("tells the child that scoped HOME is not containment", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    const disclosure = outerBoundaryNotice(
      scopedHarnessHome(wsm, envelope, true, true, "workspace_write"),
    );
    expect(disclosure).toContain(DELIBERATE_NO_OUTER_BOUNDARY_REASON);
    expect(disclosure).toContain("not containment");
    expect(outerBoundaryNotice(scopedHarnessHome(wsm, envelope, true, false))).toBeNull();
  });
});

describe("applied attempt evidence", () => {
  const historicalProven = RecordedAppliedAttemptFacts.parse({
    harness_home_isolated: true,
    harness_home_dir: "/scoped",
    access_applied: "external_sandbox_full",
    credential_profile_applied: null,
    confinement_mechanism: "seatbelt",
    confinement_profile_digest: "sha256:abc",
    confinement_verified_denied_path: "/runtime",
    confinement_unavailable_reason: null,
  });
  const deliberate = {
    harness_home_isolated: true,
    harness_home_dir: "/scoped",
    access_applied: "workspace_write" as const,
    credential_profile_applied: null,
    confinement_mechanism: null,
    confinement_profile_digest: null,
    confinement_verified_denied_path: null,
    confinement_unavailable_reason: DELIBERATE_NO_OUTER_BOUNDARY_REASON,
  };

  it("writes an incomplete all-null block before home selection", () => {
    const facts = appliedAttemptFacts(undefined, "workspace_write", null);
    expect(facts).toEqual({
      harness_home_dir: null,
      access_applied: "workspace_write",
      credential_profile_applied: null,
      confinement_mechanism: null,
      confinement_profile_digest: null,
      confinement_verified_denied_path: null,
      confinement_unavailable_reason: null,
    });
    expect(appliedEvidenceComplete(facts)).toBe(false);
  });

  it("accepts historical proven Seatbelt and current deliberate absence", () => {
    expect(appliedEvidenceComplete(historicalProven)).toBe(true);
    expect(appliedEvidenceComplete(deliberate)).toBe(true);
    expect(() =>
      assertDelegatedEvidence(true, "workspace_write", [{ attemptId: "a01", applied: deliberate }]),
    ).not.toThrow();
  });

  it("refuses missing or half-proven evidence", () => {
    expect(() =>
      assertDelegatedEvidence(true, "workspace_write", [{ attemptId: "a01" }]),
    ).toThrowError(DelegatedEvidenceIncompleteError);
    expect(
      appliedEvidenceComplete({
        ...historicalProven,
        confinement_verified_denied_path: null,
      }),
    ).toBe(false);
  });

  it("does not gate non-delegated or readonly runs", () => {
    expect(() =>
      assertDelegatedEvidence(false, "workspace_write", [{ attemptId: "a01" }]),
    ).not.toThrow();
    expect(() => assertDelegatedEvidence(true, "readonly", [{ attemptId: "a01" }])).not.toThrow();
  });
});
