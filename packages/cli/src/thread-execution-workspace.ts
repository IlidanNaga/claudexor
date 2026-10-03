import { statSync } from "node:fs";
import type { AccessProfile, ModeKind, Thread } from "@claudexor/schema";
import {
  resolveRunAccess,
  runStartRequiresGit,
  type ControlRunStartRequest,
} from "@claudexor/schema";
import { ensureThreadWorktree, type ThreadWorktreeResult } from "@claudexor/workspace";

export interface ThreadWorkspaceAuthority {
  getThread(id: string): Thread | undefined;
  setThreadWorktree(id: string, path: string, baseSha: string): void;
}

export interface ThreadExecutionWorkspace {
  executionRoot?: string;
  inPlace: boolean;
  promoted: boolean;
  projectGitInitialization?: ThreadWorktreeResult["projectGitInitialization"];
}

/**
 * Whether the durable thread/project context requires a Git worktree to be
 * materialized before this turn. Read-only may reuse an existing worktree but
 * never requires one. This is the shared decision used by both preflight and
 * the actual resolver; keeping it pure prevents admission from drifting from
 * workspace preparation after a new promotion rule is added.
 */
export function threadExecutionRequiresWorktree(input: {
  thread?: Pick<Thread, "workspace">;
  mode: ModeKind;
  access?: AccessProfile;
  accessDefault?: AccessProfile;
  protectedPaths: readonly string[];
}): boolean {
  if (!input.thread) return false;
  if (
    resolveRunAccess(
      { mode: input.mode, access: input.access },
      input.accessDefault ?? "workspace_write",
    ).effective === "readonly"
  ) {
    return false;
  }
  return (
    input.thread.workspace.mode === "isolated" ||
    (input.thread.workspace.mode === "in_place" &&
      input.mode === "agent" &&
      input.protectedPaths.length > 0)
  );
}

/** Canonical Git admission decision after thread/project context is resolved. */
export function threadRunStartRequiresGit(
  request: ControlRunStartRequest,
  thread: Pick<Thread, "workspace"> | undefined,
  protectedPaths: readonly string[],
  accessDefault: AccessProfile = "workspace_write",
): boolean {
  const mode = request.mode ?? "agent";
  const effectiveAccess = resolveRunAccess(request, accessDefault).effective;
  return runStartRequiresGit(request, {
    effectiveAccess,
    effectiveWorkspaceRequiresGit: threadExecutionRequiresWorktree({
      thread,
      mode,
      access: request.access,
      accessDefault,
      protectedPaths,
    }),
  });
}

function isolatedWorktreeUnavailable(path: string, detail: string): Error {
  return Object.assign(new Error(`isolated thread worktree is unavailable at ${path}: ${detail}`), {
    status: 409,
    code: "isolated_worktree_unavailable",
    retryable: false,
  });
}

function assertExistingIsolatedWorktree(path: string): void {
  try {
    if (!statSync(path).isDirectory()) {
      throw isolatedWorktreeUnavailable(path, "the recorded path is not a directory");
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "isolated_worktree_unavailable"
    ) {
      throw error;
    }
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "unreadable";
    throw isolatedWorktreeUnavailable(path, code);
  }
}

/** Resolve the effective execution tree before any adapter can start. */
export async function resolveThreadExecutionWorkspace(input: {
  threadId?: string;
  repoRoot: string;
  mode: ModeKind;
  access?: AccessProfile;
  accessDefault?: AccessProfile;
  requestedInPlace: boolean;
  workspaceKind?: "git" | "directory";
  protectedPaths: readonly string[];
  threads: ThreadWorkspaceAuthority;
  ensureWorktree?: (repoRoot: string, threadId: string) => Promise<ThreadWorktreeResult>;
}): Promise<ThreadExecutionWorkspace> {
  const thread = input.threadId ? input.threads.getThread(input.threadId) : undefined;
  if (input.workspaceKind === "directory")
    return { inPlace: input.requestedInPlace, promoted: false };
  if (!thread || !input.threadId) {
    return { inPlace: input.requestedInPlace, promoted: false };
  }
  const effectiveAccess = resolveRunAccess(
    { mode: input.mode, access: input.access },
    input.accessDefault ?? "workspace_write",
  ).effective;
  if (effectiveAccess === "readonly") {
    const existingPath =
      thread.workspace.mode === "isolated" ? thread.workspace.worktree_path : null;
    if (existingPath) {
      assertExistingIsolatedWorktree(existingPath);
      return { executionRoot: existingPath, inPlace: true, promoted: false };
    }
    return { executionRoot: input.repoRoot, inPlace: true, promoted: false };
  }
  const needsWorktree = threadExecutionRequiresWorktree({
    thread,
    mode: input.mode,
    access: input.access,
    accessDefault: input.accessDefault,
    protectedPaths: input.protectedPaths,
  });
  const promote = thread.workspace.mode === "in_place" && needsWorktree;
  if (!needsWorktree) {
    return { inPlace: input.requestedInPlace, promoted: false };
  }

  const ensure = input.ensureWorktree ?? ensureThreadWorktree;
  const worktree = await ensure(input.repoRoot, input.threadId);
  if (promote || worktree.created) {
    input.threads.setThreadWorktree(input.threadId, worktree.path, worktree.baseSha);
  }
  return {
    executionRoot: worktree.path,
    inPlace: true,
    promoted: promote,
    projectGitInitialization: worktree.projectGitInitialization,
  };
}
