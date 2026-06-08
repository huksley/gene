/**
 * Pluggable forge layer. The pipeline talks to "a forge" (a git host that hosts
 * repos and change requests) only through this interface, so swapping GitLab for
 * GitHub — or adding a third — is a single new file + a switch entry.
 *
 * Responsibilities split two ways:
 *  - the orchestrator uses {ensureClone, detectDefaultBranch, closeChangeRequestForBranch}
 *  - the spawned agent opens the change request itself, guided by promptSnippet()
 *    and permitted by allowedTools().
 */

import type { RepoTarget } from "../repos.ts";
import { GitlabForge } from "./gitlab.ts";
import { GithubForge } from "./github.ts";

export type ChangeRequestContext = {
  issueId: string;
  issueUrl: string;
  branch: string;
  baseBranch: string;
};

/** Coarse CI verdict for a change request's head. "none" = no pipeline/checks. */
export type CiStatus = "success" | "failed" | "running" | "none";

export type ReviewComment = {
  id: string;
  author: string;
  body: string;
  /** ISO timestamp; used to order comments and detect ones newer than our cursor. */
  createdAt: string;
  /** True when the body carries Gene's marker — i.e. it's Gene's own, not a human's. */
  isAgent: boolean;
};

/** A snapshot of an open change request: its CI verdict and discussion. */
export type ChangeRequestReview = {
  /** Web URL of the MR/PR. */
  url: string;
  state: "open" | "merged" | "closed" | "locked";
  /** Head commit the CI ran against — debounces repeated CI-fix dispatches. */
  headSha: string;
  ci: { status: CiStatus; url?: string; detail?: string };
  /** Discussion comments + reviews, chronological, system notes excluded. */
  comments: ReviewComment[];
};

export interface Forge {
  /** Display name, e.g. "gitlab". */
  readonly name: string;
  /** Human term for a change request on this forge ("merge request" / "pull request"). */
  readonly changeRequestTerm: string;
  /** HTTPS clone URL for `git clone`. */
  cloneUrl(repo: RepoTarget): string;
  /** Clone the repo to `dest` if it isn't there already (idempotent; fetches if present). */
  ensureClone(repo: RepoTarget, dest: string): Promise<void>;
  /** Detect a local clone's default branch (falls back to "main"). */
  detectDefaultBranch(localPath: string): Promise<string>;
  /** Extra `Bash(<cli> *)` allowlist entries the agent needs to drive this forge. */
  allowedTools(): string[];
  /** Markdown instructions telling the agent exactly how to open a change request. */
  promptSnippet(ctx: ChangeRequestContext): string;
  /** Best-effort close of any open change request for `branch` (used by reset). */
  closeChangeRequestForBranch(localPath: string, branch: string): Promise<void>;
  /**
   * Read the open change request for `branch` — its CI verdict and discussion —
   * without needing a local clone (queries the forge API by repo path). Returns
   * null when no open MR/PR exists for the branch. Used by the In-Review watchdog.
   */
  getReviewStatus(repo: RepoTarget, branch: string): Promise<ChangeRequestReview | null>;
}

export const selectForge = (name: "gitlab" | "github"): Forge =>
  name === "github" ? new GithubForge() : new GitlabForge();
