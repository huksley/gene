/**
 * GitLab forge implementation, driven by the `glab` CLI (+ git). Self-managed
 * hosts (gitlab.datacrunch.io) are targeted via the GITLAB_HOST env var, which
 * glab honours for non-default instances.
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

/** GitLab pipeline statuses that mean "still going" (not yet a verdict). */
const GITLAB_RUNNING = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled"
]);

const mapPipelineStatus = (status: string | undefined): CiStatus => {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (status && GITLAB_RUNNING.has(status)) return "running";
  return "none"; // canceled / skipped / manual / absent
};

const mapMrState = (state: string | undefined): ChangeRequestReview["state"] =>
  state === "opened" ? "open" : state === "merged" ? "merged" : state === "locked" ? "locked" : "closed";

export class GitlabForge implements Forge {
  readonly name = "gitlab";
  readonly changeRequestTerm = "merge request";

  cloneUrl(repo: RepoTarget): string {
    return `https://${repo.host}/${repo.repoPath}.git`;
  }

  async ensureClone(repo: RepoTarget, dest: string): Promise<void> {
    if (existsSync(path.join(dest, ".git"))) {
      logger.info(`[gitlab] clone exists at ${dest} — fetching`);
      await fetch(dest);
      return;
    }
    logger.info(`[gitlab] cloning ${repo.repoPath} from ${repo.host} -> ${dest}`);
    const env = { ...process.env, GITLAB_HOST: repo.host };
    const code = await runInherit("glab", ["repo", "clone", repo.repoPath, dest], { env });
    if (code !== 0) {
      throw new Error(
        `glab repo clone ${repo.repoPath} failed (exit ${code}). ` +
          `Run \`glab auth login --hostname ${repo.host}\` first.`
      );
    }
  }

  detectDefaultBranch(localPath: string): Promise<string> {
    return detectDefaultBranch(localPath);
  }

  allowedTools(): string[] {
    return ["Bash(glab *)"];
  }

  promptSnippet(ctx: ChangeRequestContext): string {
    return [
      "Open a **GitLab merge request** with the `glab` CLI from inside the worktree:",
      "",
      "```bash",
      `git push -u origin "${ctx.branch}"`,
      "glab mr create \\",
      `  --source-branch "${ctx.branch}" \\`,
      `  --target-branch "${ctx.baseBranch}" \\`,
      '  --title "<concise, imperative title>" \\',
      '  --description "$(cat <<\'EOF\'',
      "<what changed and why>",
      "",
      `Linear: ${ctx.issueUrl}`,
      "EOF",
      '  )" \\',
      "  --remove-source-branch \\",
      "  --yes",
      "```",
      "",
      `- The branch \`${ctx.branch}\` matches the Linear issue's branch name, so the MR auto-links to ${ctx.issueId}. Also keep the \`Linear: ${ctx.issueUrl}\` line in the description.`,
      "- **Never merge the MR** — a human reviews and merges. Do not push to the default branch.",
      "- `glab` auto-detects the host from the worktree's git remote; no extra config needed."
    ].join("\n");
  }

  async closeChangeRequestForBranch(localPath: string, branch: string): Promise<void> {
    await run("glab", ["mr", "close", branch], { cwd: localPath });
  }

  async getReviewStatus(repo: RepoTarget, branch: string): Promise<ChangeRequestReview | null> {
    const enc = encodeURIComponent(repo.repoPath);
    const apiEnv = { ...process.env, GITLAB_HOST: repo.host };
    // glab api hits /api/v4/<path>; returns the parsed JSON, or null on any failure.
    const api = async (query: string): Promise<any> => {
      const res = await run("glab", ["api", query], { env: apiEnv });
      if (res.code !== 0) {
        return null;
      }
      try {
        return JSON.parse(res.stdout);
      } catch {
        return null;
      }
    };

    const mrs = await api(
      `projects/${enc}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened&per_page=1`
    );
    const mr: any = Array.isArray(mrs) ? mrs[0] : undefined;
    if (!mr) {
      return null;
    }
    const headSha: string = mr.sha ?? mr.diff_refs?.head_sha ?? "";

    // Prefer the MR's head pipeline; fall back to the latest pipeline for the branch.
    let ci: ChangeRequestReview["ci"] = { status: "none" };
    if (mr.head_pipeline?.status) {
      ci = {
        status: mapPipelineStatus(mr.head_pipeline.status),
        url: mr.head_pipeline.web_url,
        detail: mr.head_pipeline.status
      };
    } else {
      const pipelines = await api(
        `projects/${enc}/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`
      );
      const pipeline: any = Array.isArray(pipelines) ? pipelines[0] : undefined;
      if (pipeline) {
        ci = { status: mapPipelineStatus(pipeline.status), url: pipeline.web_url, detail: pipeline.status };
      }
    }

    const notes = await api(`projects/${enc}/merge_requests/${mr.iid}/notes?sort=asc&per_page=100`);
    const comments: ReviewComment[] = Array.isArray(notes)
      ? notes
          .filter((n: any) => !n.system) // drop "changed status to…" system notes
          .map((n: any) => {
            const body = String(n.body ?? "");
            return {
              id: String(n.id),
              author: n.author?.username ?? "?",
              body,
              createdAt: String(n.created_at ?? ""),
              isAgent: body.includes(env.AGENT_MARKER)
            };
          })
      : [];

    return { url: String(mr.web_url ?? ""), state: mapMrState(mr.state), headSha, ci, comments };
  }
}
