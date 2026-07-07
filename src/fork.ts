/**
 * Fork an issue's work branch into the directory Gene was launched from
 * (`REPO_ROOT` = `process.cwd()` — the operator's own checkout). Bound to `F`
 * inside a ticket in the TUI.
 *
 * It's a convenience for "let me look at / take over what the agent did": the
 * agent works in a throwaway worktree under `.gene/repos/.worktrees/…` on a branch
 * it pushes to the repo's origin. Fork pulls that branch straight into your working
 * copy so you can inspect or continue the work without hunting for the worktree.
 *
 * Guards — nothing is touched unless BOTH hold:
 *   1. `REPO_ROOT`'s `origin` is the same repo the ticket targets, otherwise the
 *      branch would be meaningless there (compared after normalising https/ssh
 *      remote forms, since Gene clones via gh/glab whose protocol may differ from
 *      the operator's own clone).
 *   2. `REPO_ROOT`'s working tree is clean, so the checkout can't clobber
 *      uncommitted work.
 *
 * Then it fetches the branch from origin and checks it out in `REPO_ROOT`: a fresh
 * local branch when absent, else a switch + fast-forward (never a force-update, so
 * any local commits survive — the clean-tree check only guards *uncommitted* work).
 *
 * Purely local: it makes no tracker/forge writes and records nothing to the
 * activity log, so it ignores `GENE_DRY_RUN`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import logger from "./logger.ts";
import { REPO_ROOT, WORKTREES_ROOT } from "./config.ts";
import { run } from "./exec.ts";
import { findClones, listMatchingBranches } from "./reset.ts";

/** Outcome of a fork attempt — the TUI turns `message` into a toast either way. */
export interface ForkResult {
  ok: boolean;
  message: string;
}

/**
 * Reduce a git remote URL to a comparable "host/owner/repo" key so the https and
 * ssh forms of the same repo compare equal:
 *   git@github.com:owner/repo.git      → github.com/owner/repo
 *   https://github.com/owner/repo.git  → github.com/owner/repo
 *   ssh://git@github.com/owner/repo    → github.com/owner/repo
 */
const remoteKey = (url: string): string => {
  const trimmed = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  // scp-like syntax [user@]host:path has no "://" — distinguish it from ssh:// URLs.
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    return `${scp[1]}/${scp[2]}`.toLowerCase();
  }
  try {
    const parsed = new URL(trimmed); // drops any userinfo (git@) automatically
    return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
};

/** `git -C <dir> remote get-url origin`, or null when there's no origin (or not a repo). */
const originUrl = async (dir: string): Promise<string | null> => {
  const result = await run("git", ["-C", dir, "remote", "get-url", "origin"]);
  const url = result.stdout.trim();
  return result.code === 0 && url ? url : null;
};

/** The branch a worktree's HEAD is on, or null when detached / not a worktree. */
const worktreeBranch = async (worktreePath: string): Promise<string | null> => {
  const head = await run("git", ["-C", worktreePath, "symbolic-ref", "--short", "HEAD"]);
  const branch = head.stdout.trim();
  return head.code === 0 && branch ? branch : null;
};

/**
 * Locate the ticket's local clone + work branch by scanning clones (mirrors reset's
 * discovery). Prefers the branch the ticket's worktree HEAD is actually on; falls
 * back to a branch whose name carries the identifier when the worktree is gone.
 */
const locate = async (identifier: string): Promise<{ localPath: string; branch: string } | null> => {
  for (const { localPath, repoPath } of findClones()) {
    const worktreePath = path.join(WORKTREES_ROOT, repoPath, identifier);
    if (existsSync(worktreePath)) {
      const branch = await worktreeBranch(worktreePath);
      if (branch) {
        return { localPath, branch };
      }
    }
    const branches = await listMatchingBranches(localPath, identifier);
    if (branches.length > 0) {
      return { localPath, branch: branches[0] };
    }
  }
  return null;
};

/**
 * Check out the ticket's work branch into `REPO_ROOT`. Never throws — every failure
 * mode resolves to `{ ok: false, message }` so the TUI can surface it in one place.
 */
export const forkIssue = async (identifier: string): Promise<ForkResult> => {
  const fail = (message: string): ForkResult => {
    logger.warn(`${logger.tag.fork} ${identifier}: ${message}`);
    return { ok: false, message };
  };

  // 1. Find the ticket's clone + work branch locally.
  const found = await locate(identifier);
  if (!found) {
    return fail(`no local branch for ${identifier} yet`);
  }
  const { localPath, branch } = found;

  // 2. REPO_ROOT must be a clone of the SAME repo the ticket targets.
  const rootOrigin = await originUrl(REPO_ROOT);
  if (!rootOrigin) {
    return fail("no git origin where Gene was launched");
  }
  const ticketOrigin = await originUrl(localPath);
  if (!ticketOrigin) {
    return fail(`couldn't read origin for ${identifier}`);
  }
  if (remoteKey(rootOrigin) !== remoteKey(ticketOrigin)) {
    logger.warn(
      `${logger.tag.fork} ${identifier}: origin mismatch — here ${remoteKey(rootOrigin)}, ticket ${remoteKey(ticketOrigin)}`
    );
    return { ok: false, message: "origin differs from this repo" };
  }

  // 3. Working tree must be clean so the checkout can't clobber uncommitted work.
  const status = await run("git", ["-C", REPO_ROOT, "status", "--porcelain"]);
  if (status.code !== 0) {
    return fail("couldn't read working tree here");
  }
  if (status.stdout.trim()) {
    return fail("tree not clean — commit or stash first");
  }

  // 4. Pull the branch from origin and check it out here.
  const fetched = await run("git", ["-C", REPO_ROOT, "fetch", "origin", branch]);
  if (fetched.code !== 0) {
    return fail(`couldn't fetch ${branch} (pushed yet?)`);
  }

  const hasLocal =
    (await run("git", ["-C", REPO_ROOT, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  if (!hasLocal) {
    const checkout = await run("git", ["-C", REPO_ROOT, "checkout", "-b", branch, `origin/${branch}`]);
    if (checkout.code !== 0) {
      return fail(`couldn't check out ${branch}`);
    }
    logger.info(`${logger.tag.fork} ${identifier}: checked out new branch ${branch} in ${REPO_ROOT}`);
    return { ok: true, message: `checked out ${branch}` };
  }

  // Branch already here: switch to it, then advance to origin only when it
  // fast-forwards — never force-update, so local commits on it survive.
  const checkout = await run("git", ["-C", REPO_ROOT, "checkout", branch]);
  if (checkout.code !== 0) {
    return fail(`couldn't check out ${branch}`);
  }
  const ff = await run("git", ["-C", REPO_ROOT, "merge", "--ff-only", `origin/${branch}`]);
  const note = ff.code === 0 ? "up to date" : "local diverged, left as-is";
  logger.info(`${logger.tag.fork} ${identifier}: checked out ${branch} in ${REPO_ROOT} (${note})`);
  return { ok: true, message: `checked out ${branch} · ${note}` };
};
