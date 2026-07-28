/**
 * Draft-mode enforcement. `GENE_DRAFT_CHANGE_REQUEST` asks the agent to open its
 * change request as a draft and leave it that way (prompt.ts, plus each forge's
 * promptSnippet), but the agent holds a broadly allowlisted `gh`/`glab` and can
 * defeat that gate silently — by omitting `--draft`, by dropping GitLab's `Draft:`
 * title prefix while editing the title, or by simply running `gh pr ready`.
 *
 * So the gate is checked after the fact: when an agent run finishes, index.ts reads
 * the issue's open change request and calls {@link redraft}, which pushes it back to
 * draft if the agent left it ready for review.
 *
 * Only right after a run — never on a routine poll. Outside that window a non-draft
 * change request is the *human* having marked it ready, which is the whole point of
 * draft mode; re-drafting then would fight the reviewer.
 */

import logger from "./logger.ts";
import type { ChangeRequestReview, Forge } from "./forge/index.ts";
import type { RepoTarget } from "./repos.ts";

/** How to name a change request in a log line — its URL, or `#iid` when we have no URL. */
const label = (review: ChangeRequestReview): string => review.url || `#${review.iid}`;

/**
 * True when `review` is an open change request that has escaped draft. Pure, and it
 * deliberately doesn't read config: the caller applies the GENE_DRAFT_CHANGE_REQUEST
 * gate, so draft mode being off costs no forge calls at all.
 */
export const needsRedraft = (
  review: ChangeRequestReview | null | undefined
): review is ChangeRequestReview => review != null && review.state === "open" && !review.isDraft;

/**
 * Force `review` back to draft. Returns a detail string for the issue's activity log
 * when it actually re-drafted, or null when there was nothing to do or the forge
 * wouldn't do it — so the log never claims an enforcement that didn't happen.
 * Best-effort by contract: it reports failure, it doesn't throw.
 */
export const redraft = async (
  review: ChangeRequestReview | null | undefined,
  target: RepoTarget,
  forge: Forge
): Promise<string | null> => {
  if (!needsRedraft(review)) {
    return null;
  }
  logger.warn(
    `${logger.tag.review} draft mode: ${forge.changeRequestTerm} ${label(review)} is ready for review — re-drafting`
  );
  if (!(await forge.markDraft(target, review.iid))) {
    logger.error(
      `${logger.tag.review} draft mode: could not re-draft ${label(review)} — it stays ready for review`
    );
    return null;
  }

  // Confirm rather than trust the exit code. GitLab's draft state is a title prefix,
  // and GitHub refuses the conversion for some PRs (in a merge queue, or a repo on a
  // plan without draft PRs) — a wrong claim in the activity log is worse than one
  // extra read. A read that *fails* isn't evidence the write did, so only a CR we can
  // see is still ready counts as a failure.
  const after = await forge.getReviewByIid(target, review.iid);
  if (after && !after.isDraft) {
    logger.error(
      `${logger.tag.review} draft mode: ${label(review)} is still ready for review after re-drafting — ` +
      "a human needs to put it back to draft"
    );
    return null;
  }
  return `forced ${forge.changeRequestTerm} back to draft: ${label(review)}`;
};
