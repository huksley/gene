/**
 * Change-request watchdog. Once an issue has an open MR/PR — whether a previous
 * Gene run opened it, or a human attached a draft for Gene to continue — this
 * module finds it, reads the forge for two kinds of signal, and decides whether
 * the agent should be (re-)dispatched:
 *
 *   - **failing CI** — a GitLab pipeline / GitHub Actions run that failed; and
 *   - **new human review comments** on the MR/PR.
 *
 * Discovery prefers an MR/PR *attached/linked* to the issue (by iid, so it works
 * even when the change request lives on a branch other than the issue's), and
 * falls back to an MR/PR on the issue's own branch.
 *
 * A small per-issue cursor (in Postgres, see db.ts) records what we've already
 * acted on — the failed head SHA and the newest handled comment — so we dispatch
 * once per signal, not on every poll. The In-Review rules:
 *
 *   - CI still **running** → wait (no-op); don't pile work on mid-flight CI.
 *   - CI **failed** at a head we haven't handled → act.
 *   - a **new human comment** since the cursor → act.
 *   - otherwise → no-op, and the daemon moves on to other issues.
 *
 * Picking up an *attached draft* (a Todo issue that already has an open MR/PR) is
 * the same machinery with `alwaysAct` — there's queued work to continue, so we
 * dispatch regardless of whether CI/comments changed.
 */

import { getDb } from "./db.ts";
import { commentIsIgnored } from "./ignore.ts";
import { tracker } from "./tracker/index.ts";
import type { Forge, ChangeRequestReview, ReviewComment } from "./forge/index.ts";
import { findChangeRequestRefs, refMatchesTarget, type RepoTarget } from "./repos.ts";
import type { Comment, Issue } from "./tracker/index.ts";
import logger from "./logger.ts";

/** What the agent needs to know to address/continue the change request (fed into the prompt). */
export type ReviewContext = {
  /** Human term for a change request on this forge ("merge request" / "pull request"). */
  crTerm: string;
  /** Web URL of the MR/PR. */
  crUrl: string;
  /** MR iid / PR number, as a string (identifies the change request to the forge CLI). */
  iid: string;
  /** <boolean> `true` while the change request is still a draft / work-in-progress. */
  isDraft: boolean;
  /** The change request's own branches — the worktree checks out the source branch. */
  sourceBranch: string;
  targetBranch: string;
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
 * Resolve the change request for an issue and return the first one matching
 * `accept`. Prefers an MR/PR attached/linked to the issue (tracker attachment,
 * then description, then comments — matched to the resolved target repo and looked
 * up by iid, so a human's branch name is fine); falls back to an MR/PR on the
 * issue's own branch. Null if none matches.
 */
const resolveChangeRequest = async (
  issue: Issue,
  comments: Comment[],
  target: RepoTarget,
  forge: Forge,
  accept: (review: ChangeRequestReview) => boolean
): Promise<ChangeRequestReview | null> => {
  let attachmentUrls: string[] = [];
  try {
    attachmentUrls = (await tracker.getAttachments(issue)).map(a => a.url);
  } catch (error) {
    logger.warn(
      `${logger.tag.review} [${issue.identifier}] could not read ${tracker.name} attachments:`,
      error instanceof Error ? error.message : error
    );
  }

  const texts = [...attachmentUrls, issue.description, ...comments.map(c => c.body)];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const ref of findChangeRequestRefs(text)) {
      if (!refMatchesTarget(ref, target) || seen.has(ref.iid)) {
        continue;
      }
      seen.add(ref.iid);
      const review = await forge.getReviewByIid(target, ref.iid);
      if (review && accept(review)) {
        return review;
      }
    }
  }

  const byBranch = await forge.getReviewStatus(target, issue.branchName);
  return byBranch && accept(byBranch) ? byBranch : null;
};

/** The issue's currently-open change request, or null. */
export const findOpenChangeRequest = (
  issue: Issue,
  comments: Comment[],
  target: RepoTarget,
  forge: Forge
): Promise<ChangeRequestReview | null> =>
  resolveChangeRequest(issue, comments, target, forge, review => review.state === "open");

/** The issue's change request if it has already merged, or null. */
export const findMergedChangeRequest = (
  issue: Issue,
  comments: Comment[],
  target: RepoTarget,
  forge: Forge
): Promise<ChangeRequestReview | null> =>
  resolveChangeRequest(issue, comments, target, forge, review => review.state === "merged");

const toContext = (forge: Forge, review: ChangeRequestReview, newComments: ReviewComment[]): ReviewContext => ({
  crTerm: forge.changeRequestTerm,
  crUrl: review.url,
  iid: review.iid,
  isDraft: review.isDraft,
  sourceBranch: review.sourceBranch,
  targetBranch: review.targetBranch,
  ci: review.ci,
  newComments
});

/**
 * Given an already-found open change request, decide whether to (re-)dispatch the
 * agent, comparing CI + comments against the persisted cursor. With `alwaysAct`
 * (picking up an attached draft), dispatch even if nothing changed — there's work
 * queued — but still skip if CI is mid-flight to avoid racing it. Reads state but
 * writes nothing; the caller persists `nextCursor` only if it actually dispatches.
 */
const decideReviewOutcome = async (
  review: ChangeRequestReview,
  issueId: string,
  forge: Forge,
  alwaysAct: boolean
): Promise<ReviewOutcome> => {
  if (review.ci.status === "running") {
    return { act: false, reason: "CI still running — waiting" };
  }

  const cursor = await readCursor(issueId);
  const newComments = review.comments.filter(
    c =>
      !c.isAgent &&
      (cursor.handledCommentAt === undefined || c.createdAt > cursor.handledCommentAt) &&
      // Ignore-listed review comments don't re-trigger, and (since toContext feeds the
      // prompt from newComments) are also kept out of what the agent is asked to address.
      !commentIsIgnored(forge.name, c.body)
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
    if (!alwaysAct) {
      return { act: false, reason: `nothing new (CI ${review.ci.status}, no new comments)` };
    }
    // Draft pickup: act anyway — the open change request itself is the work.
    reasons.push(review.isDraft ? "continuing the attached draft" : "continuing the attached change request");
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
    context: toContext(forge, review, newComments),
    nextCursor: {
      handledCommentAt: newestCommentAt,
      handledFailedSha: review.ci.status === "failed" ? review.headSha : cursor.handledFailedSha
    }
  };
};

/**
 * In-Review evaluation: find the issue's open change request and decide whether
 * failing CI / new review comments warrant a re-dispatch (gated — a quiet, green
 * CR is a no-op).
 */
export const evaluateReview = async (
  issue: Issue,
  comments: Comment[],
  target: RepoTarget,
  forge: Forge
): Promise<ReviewOutcome> => {
  const review = await findOpenChangeRequest(issue, comments, target, forge);
  if (!review) {
    return { act: false, reason: "no open change request for the issue (merged, closed, or not opened yet)" };
  }
  return decideReviewOutcome(review, issue.identifier, forge, false);
};

/**
 * Draft pickup: if a Todo issue already has an open MR/PR attached, return an
 * outcome that continues it (always acts). Returns null when nothing is attached,
 * so the caller proceeds with a fresh start instead.
 */
export const evaluateDraftPickup = async (
  issue: Issue,
  comments: Comment[],
  target: RepoTarget,
  forge: Forge
): Promise<ReviewOutcome | null> => {
  const review = await findOpenChangeRequest(issue, comments, target, forge);
  if (!review) {
    return null;
  }
  return decideReviewOutcome(review, issue.identifier, forge, true);
};
