/**
 * GitHub forge implementation, driven by the `gh` CLI (+ git). Present mainly to
 * prove the Forge abstraction is genuinely pluggable; GitLab is the default.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import logger from "../logger.ts";
import { env } from "../config.ts";
import { run, runInherit } from "../exec.ts";
import { detectDefaultBranch, fetch } from "../git.ts";
import type { RepoTarget } from "../repos.ts";
import type {
  ChangeRequestContext,
  ChangeRequestReview,
  CiStatus,
  Forge,
  ReviewComment
} from "./index.ts";

const GH_FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "ERROR"
]);

/**
 * Collapse a PR's statusCheckRollup (a mix of CheckRun and StatusContext nodes)
 * into one verdict. Running wins over failed (wait for everything to settle
 * before acting); failed wins over success.
 */
const mapRollup = (rollup: any[]): ChangeRequestReview["ci"] => {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return { status: "none" };
  }
  let running = 0;
  let failed = 0;
  let failedName: string | undefined;
  let failedUrl: string | undefined;
  for (const c of rollup) {
    const status: string | undefined = c.status; // CheckRun: QUEUED/IN_PROGRESS/COMPLETED
    const state: string | undefined = c.state; // StatusContext: PENDING/SUCCESS/ERROR/FAILURE
    if (status === "QUEUED" || status === "IN_PROGRESS" || state === "PENDING" || state === "EXPECTED") {
      running += 1;
      continue;
    }
    const verdict = String(c.conclusion ?? state ?? "").toUpperCase();
    if (GH_FAILED.has(verdict)) {
      failed += 1;
      failedName ??= c.name ?? c.context;
      failedUrl ??= c.detailsUrl ?? c.targetUrl;
    }
  }
  if (running > 0) return { status: "running" };
  if (failed > 0) {
    return {
      status: "failed",
      url: failedUrl,
      detail: failedName ? `${failed} failing check(s), e.g. ${failedName}` : `${failed} failing check(s)`
    };
  }
  return { status: "success" };
};

const mapPrState = (state: string | undefined): ChangeRequestReview["state"] => {
  const s = String(state ?? "").toUpperCase();
  return s === "OPEN" ? "open" : s === "MERGED" ? "merged" : "closed";
};

export class GithubForge implements Forge {
  readonly name = "github";
  readonly changeRequestTerm = "pull request";

  cloneUrl(repo: RepoTarget): string {
    return `https://${repo.host}/${repo.repoPath}.git`;
  }

  async ensureClone(repo: RepoTarget, dest: string): Promise<void> {
    if (existsSync(path.join(dest, ".git"))) {
      logger.info(`[github] clone exists at ${dest} — fetching`);
      await fetch(dest);
      return;
    }
    logger.info(`[github] cloning ${repo.repoPath} from ${repo.host} -> ${dest}`);
    // gh defaults to github.com; point it at an enterprise host when needed.
    const env = { ...process.env };
    if (repo.host !== "github.com") {
      env.GH_HOST = repo.host;
    }
    const code = await runInherit("gh", ["repo", "clone", repo.repoPath, dest], { env });
    if (code !== 0) {
      throw new Error(`gh repo clone ${repo.repoPath} failed (exit ${code}). Run \`gh auth login\` first.`);
    }
  }

  detectDefaultBranch(localPath: string): Promise<string> {
    return detectDefaultBranch(localPath);
  }

  allowedTools(): string[] {
    return ["Bash(gh *)"];
  }

  promptSnippet(ctx: ChangeRequestContext): string {
    return [
      "Open a **GitHub pull request** with the `gh` CLI from inside the worktree:",
      "",
      "```bash",
      `git push -u origin "${ctx.branch}"`,
      "gh pr create \\",
      `  --base "${ctx.baseBranch}" \\`,
      `  --head "${ctx.branch}" \\`,
      '  --title "<concise, imperative title>" \\',
      '  --body "$(cat <<\'EOF\'',
      "<what changed and why>",
      "",
      `Linear: ${ctx.issueUrl}`,
      "EOF",
      '  )"',
      "```",
      "",
      `- The branch \`${ctx.branch}\` matches the Linear issue's branch name, so the PR auto-links to ${ctx.issueId}. Also keep the \`Linear: ${ctx.issueUrl}\` line in the body.`,
      "- **Never merge the PR** — a human reviews and merges. Do not push to the default branch."
    ].join("\n");
  }

  async closeChangeRequestForBranch(localPath: string, branch: string): Promise<void> {
    await run("gh", ["pr", "close", branch], { cwd: localPath });
  }

  async getReviewStatus(repo: RepoTarget, branch: string): Promise<ChangeRequestReview | null> {
    const ghEnv: NodeJS.ProcessEnv = { ...process.env };
    if (repo.host !== "github.com") {
      ghEnv.GH_HOST = repo.host;
    }
    const R = repo.repoPath;

    const listRes = await run(
      "gh",
      ["pr", "list", "-R", R, "--head", branch, "--state", "open", "--json", "number", "--limit", "1"],
      { env: ghEnv }
    );
    if (listRes.code !== 0) {
      return null;
    }
    let prs: any;
    try {
      prs = JSON.parse(listRes.stdout);
    } catch {
      return null;
    }
    const pr: any = Array.isArray(prs) ? prs[0] : undefined;
    if (!pr) {
      return null;
    }

    const viewRes = await run(
      "gh",
      [
        "pr",
        "view",
        String(pr.number),
        "-R",
        R,
        "--json",
        "url,state,headRefOid,statusCheckRollup,comments,reviews"
      ],
      { env: ghEnv }
    );
    let v: any = {};
    try {
      v = JSON.parse(viewRes.stdout);
    } catch {
      v = {};
    }

    const marker = env.AGENT_MARKER;
    const toComment = (id: string, author: string, body: string, createdAt: string): ReviewComment => ({
      id,
      author,
      body,
      createdAt,
      isAgent: body.includes(marker)
    });
    const fromComments: ReviewComment[] = (v.comments ?? []).map((c: any) =>
      toComment(String(c.id ?? c.url ?? ""), c.author?.login ?? "?", String(c.body ?? ""), String(c.createdAt ?? ""))
    );
    const fromReviews: ReviewComment[] = (v.reviews ?? [])
      .filter((r: any) => String(r.body ?? "").trim().length > 0)
      .map((r: any) =>
        toComment(
          String(r.id ?? `${r.author?.login}-${r.submittedAt}`),
          r.author?.login ?? "?",
          String(r.body ?? ""),
          String(r.submittedAt ?? "")
        )
      );
    const comments = [...fromComments, ...fromReviews]
      .filter(c => c.createdAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return {
      url: String(v.url ?? ""),
      state: mapPrState(v.state),
      headSha: String(v.headRefOid ?? ""),
      ci: mapRollup(v.statusCheckRollup ?? []),
      comments
    };
  }
}
