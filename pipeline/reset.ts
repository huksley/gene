/**
 * Reset a card's pipeline state: remove the agent's worktree + branch + lock,
 * and clear all AI labels from the Trello card. Use when you want a fresh
 * autonomous run from scratch instead of resume-from-branch semantics.
 *
 * Usage:
 *   npm run pipeline:reset -- <shortLink>
 *   npm run pipeline:reset -- <shortLink> --close-pr
 *
 * --close-pr also closes any open PR for branches matching `fix/trello-<shortLink>-*`.
 */

import { spawnSync } from "child_process";
import { existsSync, rmSync, unlinkSync } from "fs";
import path from "path";
import logger from "@/lib/logger";
import { LABELS, env } from "./config";
import { removeLabelFromCard } from "./trello";

const REPO_ROOT = process.cwd();

type TrelloCardLite = { id: string; name: string };

const fetchCard = async (idOrShortLink: string): Promise<TrelloCardLite> => {
  const url = `https://api.trello.com/1/cards/${idOrShortLink}?key=${env.TRELLO_API_KEY}&token=${env.TRELLO_TOKEN}&fields=id,name`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`could not find card ${idOrShortLink}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TrelloCardLite;
};

const run = (cmd: string, args: string[], allowFail = false): boolean => {
  const result = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.status !== 0 && !allowFail) {
    logger.warn(
      `[pipeline:reset] \`${cmd} ${args.join(" ")}\` exited ${result.status ?? "?"}`
    );
    return false;
  }
  return result.status === 0;
};

const listMatchingBranches = (shortLink: string): string[] => {
  const result = spawnSync(
    "git",
    ["for-each-ref", "--format=%(refname:short)", `refs/heads/fix/trello-${shortLink}-*`],
    { cwd: REPO_ROOT, encoding: "utf-8" }
  );
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .trim()
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
};

const main = async (): Promise<void> => {
  const shortLink = process.argv[2];
  if (!shortLink || shortLink.startsWith("--")) {
    logger.error("[pipeline:reset] Usage: npm run pipeline:reset -- <shortLink> [--close-pr]");
    process.exit(1);
  }
  const closePR = process.argv.includes("--close-pr");

  const card = await fetchCard(shortLink);
  logger.info(`[pipeline:reset] target: [${shortLink}] "${card.name}" (id=${card.id})`);

  const worktreePath = path.join(REPO_ROOT, ".ai-pipeline", "worktrees", shortLink);
  if (existsSync(worktreePath)) {
    logger.info(`[pipeline:reset] removing worktree ${worktreePath}`);
    run("git", ["worktree", "remove", "--force", worktreePath], true);
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  } else {
    logger.info(`[pipeline:reset] no worktree at ${worktreePath} (skipping)`);
  }

  const branches = listMatchingBranches(shortLink);
  for (const branch of branches) {
    logger.info(`[pipeline:reset] deleting branch ${branch}`);
    run("git", ["branch", "-D", branch], true);
  }
  if (branches.length === 0) {
    logger.info(`[pipeline:reset] no matching branches for fix/trello-${shortLink}-*`);
  }

  if (closePR) {
    for (const branch of branches) {
      logger.info(`[pipeline:reset] closing PR for branch ${branch}`);
      run(
        "gh",
        ["pr", "close", branch, "--comment", `Closed by pipeline:reset for ${shortLink}`],
        true
      );
    }
  }

  const lockFile = path.join(REPO_ROOT, ".ai-pipeline", "locks", `${card.id}.lock`);
  if (existsSync(lockFile)) {
    logger.info(`[pipeline:reset] removing lock ${lockFile}`);
    unlinkSync(lockFile);
  }

  for (const labelId of [LABELS.AI_WORKING, LABELS.AI_BLOCKED, LABELS.AI_DONE]) {
    try {
      await removeLabelFromCard(card.id, labelId);
    } catch {
      /* label might not be applied — Trello returns 404, which trelloDelete already ignores */
    }
  }
  logger.info(
    "[pipeline:reset] ✓ done — move the card back to AI Code Assistant to re-trigger"
  );
};

main().catch(error => {
  logger.error("[pipeline:reset] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
