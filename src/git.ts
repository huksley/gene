/**
 * Git plumbing shared by the forge layer, the worktree manager (invoke), and the
 * reset CLI. Kept forge-agnostic — anything host-specific lives under src/forge.
 */

import { run, runOrThrow } from "./exec.ts";

/** Detect the default branch of a local clone; falls back to "main". */
export const detectDefaultBranch = async (localPath: string): Promise<string> => {
  const direct = await run("git", ["-C", localPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (direct.code === 0 && direct.stdout.trim()) {
    return direct.stdout.trim().replace(/^origin\//, "");
  }
  // origin/HEAD may not be set on a bare-ish or older clone — ask the remote.
  await run("git", ["-C", localPath, "remote", "set-head", "origin", "--auto"]);
  const retry = await run("git", ["-C", localPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (retry.code === 0 && retry.stdout.trim()) {
    return retry.stdout.trim().replace(/^origin\//, "");
  }
  return "main";
};

/** Fetch a branch (or all) into a local clone. Updates shared refs for worktrees. */
export const fetch = async (localPath: string, branch?: string): Promise<void> => {
  const args = branch
    ? ["-C", localPath, "fetch", "origin", branch]
    : ["-C", localPath, "fetch", "--prune", "origin"];
  await run("git", args);
};

/** Count commits in origin/<base> not yet in the worktree's HEAD (0 on error). */
export const commitsBehind = async (worktreePath: string, baseBranch: string): Promise<number> => {
  const result = await run("git", [
    "-C",
    worktreePath,
    "rev-list",
    "--count",
    `HEAD..origin/${baseBranch}`
  ]);
  if (result.code !== 0) {
    return 0;
  }
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Add a worktree branched off origin/<base>. Reuses the branch ref if present. */
export const addWorktree = async (
  localPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string
): Promise<void> => {
  await runOrThrow("git", [
    "-C",
    localPath,
    "worktree",
    "add",
    "-B",
    branch,
    worktreePath,
    `origin/${baseBranch}`
  ]);
};

/** Remove a worktree (best-effort; force handles dirty trees). */
export const removeWorktree = async (localPath: string, worktreePath: string): Promise<void> => {
  await run("git", ["-C", localPath, "worktree", "remove", "--force", worktreePath]);
};

/** Delete a local branch (best-effort). */
export const deleteBranch = async (localPath: string, branch: string): Promise<void> => {
  await run("git", ["-C", localPath, "branch", "-D", branch]);
};
