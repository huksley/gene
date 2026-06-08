/**
 * In-Review watchdog. Once an issue's agent has opened a change request, the
 * issue sits in the review state and the human reviews it. This module polls the
 * forge for two kinds of signal and decides whether the agent should be
 * re-dispatched to address them:
 *
 *   - **failing CI** — a GitLab pipeline / GitHub Actions run that failed; and
 *   - **new human review comments** on the MR/PR.
 *
 * A small per-issue cursor (in Postgres, see db.ts) records what we've already
 * acted on — the failed head SHA and the newest handled comment — so we dispatch
 * once per signal, not on every poll. The rules:
 *
 *   - CI still **running** → wait (no-op); don't pile work on mid-flight CI.
 *   - CI **failed** at a head we haven't handled → act.
 *   - a **new human comment** since the cursor → act.
 *   - otherwise → no-op, and the daemon moves on to other issues.
 */

import { getDb } from "./db.ts";
import type { Forge, ChangeRequestReview, ReviewComment } from "./forge/index.ts";
import type { RepoTarget } from "./repos.ts";
import type { LinearIssue } from "./linear.ts";

/** What the agent needs to know to address the review (fed into the prompt). */
export type ReviewContext = {
  crTerm: string;
  crUrl: string;
  ci: ChangeRequestReview["ci"];
  newComments: ReviewComment[];
};

type ReviewCursor = { handledFailedSha?: string; handledCommentAt?: string };

export type ReviewOutcome =
  | { act: false; reason: string }
  | { act: true; reason: string; context: ReviewContext; nextCursor: ReviewCursor };

type CursorRow = { handled_failed_sha: string | null; handled_comment_at: string | null };

const readCursor = async (issueId: string): Promise<ReviewCursor> => {
  const db = await getDb();
  const res = await db.query<CursorRow>(
    "SELECT handled_failed_sha, handled_comment_at FROM review_cursor WHERE issue_id = $1",
    [issueId]
  );
  const row = res.rows[0];
  if (!row) {
    return {};
  }
  return {
    handledFailedSha: row.handled_failed_sha ?? undefined,
    handledCommentAt: row.handled_comment_at ?? undefined
  };
};

/** Persist the cursor for an issue (upsert). Called once the agent is dispatched. */
export const writeCursor = async (issueId: string, cursor: ReviewCursor): Promise<void> => {
  const db = await getDb();
  await db.query(
    `INSERT INTO review_cursor (issue_id, handled_failed_sha, handled_comment_at, updated_at)
       VALUES ($1, $2, $3, now())
     ON CONFLICT (issue_id) DO UPDATE SET
       handled_failed_sha = EXCLUDED.handled_failed_sha,
       handled_comment_at = EXCLUDED.handled_comment_at,
       updated_at = now()`,
    [issueId, cursor.handledFailedSha ?? null, cursor.handledCommentAt ?? null]
  );
};

/**
 * Decide whether an In-Review issue needs the agent re-dispatched. Reads the
 * forge (open CR + CI + comments) and compares against the persisted cursor.
 * Pure-ish: it reads state but writes nothing — the caller persists `nextCursor`
 * only if it actually dispatches.
 */
export const evaluateReview = async (
  issue: LinearIssue,
  target: RepoTarget,
  forge: Forge
): Promise<ReviewOutcome> => {
  const review = await forge.getReviewStatus(target, issue.branchName);
  if (!review) {
    return { act: false, reason: "no open change request for the branch (merged, closed, or not opened yet)" };
  }
  if (review.state !== "open") {
    return { act: false, reason: `change request is ${review.state}` };
  }

  // Honour "still running → wait": don't dispatch while CI is mid-flight.
  if (review.ci.status === "running") {
    return { act: false, reason: "CI still running — waiting" };
  }

  const cursor = await readCursor(issue.identifier);

  const newComments = review.comments.filter(
    c => !c.isAgent && (cursor.handledCommentAt === undefined || c.createdAt > cursor.handledCommentAt)
  );
  const ciNewlyFailed = review.ci.status === "failed" && cursor.handledFailedSha !== review.headSha;

  const reasons: string[] = [];
  if (ciNewlyFailed) {
    reasons.push(`CI failed${review.ci.detail ? ` (${review.ci.detail})` : ""}`);
  }
  if (newComments.length > 0) {
    reasons.push(`${newComments.length} new review comment(s)`);
  }
  if (reasons.length === 0) {
    return { act: false, reason: `nothing new (CI ${review.ci.status}, no new comments)` };
  }

  // Advance the cursor to what we're about to act on. We deliberately advance the
  // failed-SHA even though the fix may not land: re-running the same agent on the
  // same failing commit won't help, and the agent's pushed fix produces a new SHA
  // (which re-triggers if it fails again). New comments always re-trigger.
  const newestCommentAt =
    newComments.length > 0 ? newComments[newComments.length - 1]!.createdAt : cursor.handledCommentAt;

  return {
    act: true,
    reason: reasons.join(" + "),
    context: { crTerm: forge.changeRequestTerm, crUrl: review.url, ci: review.ci, newComments },
    nextCursor: {
      handledCommentAt: newestCommentAt,
      handledFailedSha: review.ci.status === "failed" ? review.headSha : cursor.handledFailedSha
    }
  };
};
