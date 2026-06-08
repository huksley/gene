/**
 * Reset one issue's pipeline state: remove the agent's worktree + branch + lock,
 * and move the issue back to the trigger state (Todo) for a fresh autonomous run.
 * The `Gene` ownership label is deliberately left untouched.
 *
 * Usage:
 *   npm run reset -- <ISSUE-ID>              # e.g. CLOUD-1094
 *   npm run reset -- <ISSUE-ID> --close-mr   # also close any open MR/PR
 *
 * Because an issue's target repo is chosen per-issue (from a link), reset doesn't
 * know it up front — instead it scans every local clone for a worktree/branch
 * matching the identifier and cleans wherever it finds one. Local cleanup always
 * runs (an explicit operator action); the tracker state move and the MR/PR close
 * honour GENE_DRY_RUN.
 */

import { existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import logger from "./logger.ts";
import { env, LOCK_DIR, REPOS_ROOT, WORKTREES_ROOT } from "./config.ts";
import { parseRepoUrl } from "./repos.ts";
import { deleteBranch, removeWorktree } from "./git.ts";
import { run } from "./exec.ts";
import { logEvent, closeDb } from "./db.ts";
import { tracker, findIssue } from "./tracker/index.ts";
import { selectForge } from "./forge/index.ts";

/** Every local clone under the repos root (a dir containing `.git`), with its repoPath. */
const findClones = (): { localPath: string; repoPath: string }[] => {
  const found: { localPath: string; repoPath: string }[] = [];
  const walk = (dir: string): void => {
    if (existsSync(path.join(dir, ".git"))) {
      found.push({ localPath: dir, repoPath: path.relative(REPOS_ROOT, dir) });
      return; // don't descend into a clone
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== ".worktrees") {
        walk(path.join(dir, entry.name));
      }
    }
  };
  if (existsSync(REPOS_ROOT)) {
    walk(REPOS_ROOT);
  }
  return found;
};

/** Branches in the clone whose name contains the issue identifier (Linear lowercases it). */
const listMatchingBranches = async (localPath: string, identifier: string): Promise<string[]> => {
  const result = await run("git", [
    "-C",
    localPath,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/"
  ]);
  if (result.code !== 0) {
    return [];
  }
  const needle = identifier.toLowerCase();
  return result.stdout
    .trim()
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .filter(branch => branch.toLowerCase().includes(needle));
};

/** Infer the forge from a clone's origin remote URL (for --close-mr). */
const forgeForClone = async (localPath: string) => {
  const result = await run("git", ["-C", localPath, "remote", "get-url", "origin"]);
  if (result.code !== 0) {
    return null;
  }
  const target = parseRepoUrl(result.stdout.trim());
  return target ? selectForge(target.forge) : null;
};

const main = async (): Promise<void> => {
  const identifier = process.argv[2];
  if (!identifier || identifier.startsWith("--")) {
    logger.error("[gene:reset] Usage: npm run reset -- <ISSUE-ID> [--close-mr]");
    process.exit(1);
  }
  const closeMr = process.argv.includes("--close-mr");

  const clones = findClones();
  logger.info(
    `[gene:reset] target: ${identifier} — scanning ${clones.length} local clone(s) for its worktree/branches`
  );

  let cleanedAnything = false;
  for (const { localPath, repoPath } of clones) {
    const worktreePath = path.join(WORKTREES_ROOT, repoPath, identifier);
    const hasWorktree = existsSync(worktreePath);
    const branches = await listMatchingBranches(localPath, identifier);
    if (!hasWorktree && branches.length === 0) {
      continue; // this clone has nothing for the issue
    }
    cleanedAnything = true;
    logger.info(
      `[gene:reset] ${repoPath}: ${hasWorktree ? "worktree + " : ""}${branches.length} branch(es)`
    );

    if (hasWorktree) {
      logger.info(`[gene:reset]   removing worktree ${worktreePath}`);
      await removeWorktree(localPath, worktreePath);
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      await run("git", ["-C", localPath, "worktree", "prune"]);
    }

    for (const branch of branches) {
      logger.info(`[gene:reset]   deleting branch ${branch}`);
      await deleteBranch(localPath, branch);
    }

    if (closeMr && branches.length > 0) {
      const forge = await forgeForClone(localPath);
      if (!forge) {
        logger.warn(`[gene:reset]   could not infer forge for ${repoPath} — skipping change-request close`);
      } else {
        for (const branch of branches) {
          if (env.DRY_RUN) {
            logger.info(`[gene:reset]   (dry-run) would close ${forge.changeRequestTerm} for ${branch}`);
            continue;
          }
          try {
            await forge.closeChangeRequestForBranch(localPath, branch);
            logger.info(`[gene:reset]   closed ${forge.changeRequestTerm} for ${branch}`);
          } catch (error) {
            logger.warn(
              `[gene:reset]   could not close ${forge.changeRequestTerm} for ${branch}:`,
              error instanceof Error ? error.message : error
            );
          }
        }
      }
    }
  }

  if (!cleanedAnything) {
    logger.info(`[gene:reset] no local worktree/branches found for ${identifier} (nothing to clean locally)`);
  }

  // Drop the lock so the next scan can re-acquire immediately.
  const lockFile = path.join(LOCK_DIR, `${identifier}.lock`);
  if (existsSync(lockFile)) {
    logger.info(`[gene:reset] removing lock ${lockFile}`);
    unlinkSync(lockFile);
  }

  // Move the issue back to the trigger state. Gene label is left untouched.
  const issue = await findIssue(identifier);
  if (issue) {
    await tracker.moveToState(issue, env.TRIGGER_STATE);
  } else {
    logger.warn(
      `[gene:reset] could not find ${identifier} on ${tracker.name} — skipping state move (local cleanup done)`
    );
  }

  logger.info(
    `[gene:reset] ✓ done — ${identifier} reset to "${env.TRIGGER_STATE}" (${env.LABEL} label kept). ` +
      "The next scan will pick it up fresh."
  );

  // Record the reset in the issue's activity log. Local cleanup always runs; the
  // state move honours GENE_DRY_RUN, so describe each part as it actually happened.
  const stateNote = issue
    ? `${env.DRY_RUN ? "would reset" : "reset"} to "${env.TRIGGER_STATE}"`
    : `not found on ${tracker.name} — state unchanged`;
  const localNote = cleanedAnything ? "cleared local worktree/branch(es)" : "no local state";
  await logEvent({
    tracker: tracker.name,
    identifier,
    event: "reset",
    detail: `${stateNote}; ${localNote}${closeMr ? "; --close-mr" : ""}`
  });

  // logEvent opened PGlite; release it so this one-shot CLI can exit.
  await closeDb();
};

main().catch(error => {
  logger.error("[gene:reset] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
