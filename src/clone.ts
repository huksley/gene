/**
 * Pre-clone the configured default repos so the common path is warm:
 *
 *   npm run clone
 *
 * This is optional — repos referenced by a per-issue link are cloned on demand at
 * dispatch time. Running it once during setup just avoids a first-dispatch clone
 * for the team defaults.
 *
 * Clones are kept under `repos/<repoPath>/` (gitignored) and reused — the daemon
 * branches per-issue worktrees off them rather than re-cloning.
 *
 * Prerequisite: `glab auth login --hostname gitlab.datacrunch.io` (and/or `gh
 * auth login` for GitHub targets).
 */

import { mkdir } from "node:fs/promises";
import logger from "./logger.ts";
import { REPOS_ROOT } from "./config.ts";
import { defaultTargets, localPathFor, targetLabel } from "./repos.ts";
import { selectForge } from "./forge/index.ts";

const main = async (): Promise<void> => {
  await mkdir(REPOS_ROOT, { recursive: true });
  const targets = defaultTargets();
  logger.info(`[gene:clone] warming ${targets.length} default repo(s) under ${REPOS_ROOT}`);

  for (const target of targets) {
    const forge = selectForge(target.forge);
    const dest = localPathFor(target);
    try {
      await forge.ensureClone(target, dest);
      const branch = target.ref ?? (await forge.detectDefaultBranch(dest));
      logger.info(`[gene:clone] ✓ ${targetLabel(target)} [${forge.name}] (base branch: ${branch})`);
    } catch (error) {
      logger.error(
        `[gene:clone] ✗ ${targetLabel(target)}:`,
        error instanceof Error ? error.message : error
      );
      process.exitCode = 1;
    }
  }
  logger.info("[gene:clone] done");
};

main().catch(error => {
  logger.error("[gene:clone] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
