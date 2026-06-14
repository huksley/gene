/**
 * Pure decision function: given an issue and its comment transcript, decide what
 * the daemon should do this cycle. No side effects — trivially testable.
 *
 * Linear workflow *states* drive the lifecycle:
 *   - TRIGGER_STATE  (Todo)        → fresh work        → processing
 *   - BLOCKED_STATE  (Blocked)     → Gene asked a Q    → resume when a human replies
 *   - ACTIVE_STATE   (In Progress) → Gene working      → handle new human feedback
 *   - REVIEW_STATE   (In Review)   → a CR is open      → check the forge for review
 *                                                        feedback / failing CI
 * The Gene label is an ownership tag and plays no part here.
 *
 * `check-review` is the one decision that can't be made from Linear alone — the
 * daemon resolves it impurely against the forge (see review.ts). A *Linear*
 * comment on an In-Review issue is still handled here, as ordinary feedback.
 */

import { env, WATCHED_STATES } from "./config.ts";
import { commentIsIgnored } from "./ignore.ts";
import type { Comment, Issue } from "./tracker/index.ts";

export type Action =
  | { kind: "nothing"; reason: string }
  | { kind: "ask-clarification"; reason: string; missingSections: string[] }
  | { kind: "processing" }
  | { kind: "resume"; latestUserCommentId: string }
  | { kind: "feedback"; latestUserCommentId: string }
  | { kind: "check-review" };

/** Headings (from GENE_REQUIRE_SECTIONS) that are absent or have an empty body. */
const findMissingSections = (desc: string, required: string[]): string[] => {
  const text = desc || "";
  return required.filter(section => {
    const headingPattern = new RegExp(
      `^${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
      "m"
    );
    if (!headingPattern.test(text)) {
      return true;
    }
    const sectionStart = text.indexOf(section);
    const nextHeading = text.slice(sectionStart + section.length).search(/\n##\s/);
    const body =
      nextHeading === -1
        ? text.slice(sectionStart + section.length)
        : text.slice(sectionStart + section.length, sectionStart + section.length + nextHeading);
    return body.trim().length === 0;
  });
};

const latestAgentComment = (comments: Comment[]): Comment | undefined => {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    if (comments[i]!.isAgent) {
      return comments[i];
    }
  }
  return undefined;
};

const userCommentsAfter = (
  comments: Comment[],
  afterIso: string | undefined
): Comment[] =>
  comments.filter(
    comment =>
      !comment.isAgent &&
      (afterIso === undefined || comment.createdAt > afterIso) &&
      // Ignore-listed comments (e.g. another bot's `/review`) don't count as feedback.
      !commentIsIgnored(env.TRACKER, comment.body)
  );

export const decideAction = (issue: Issue, comments: Comment[]): Action => {
  const lastAgent = latestAgentComment(comments);
  const newUserComments = userCommentsAfter(comments, lastAgent?.createdAt);
  const latestUserCommentId = newUserComments[newUserComments.length - 1]?.id ?? "";

  if (issue.stateName === WATCHED_STATES.trigger) {
    if (env.REQUIRE_SECTIONS.length > 0) {
      const missing = findMissingSections(issue.description, env.REQUIRE_SECTIONS);
      if (missing.length > 0) {
        return { kind: "ask-clarification", reason: "missing-required-sections", missingSections: missing };
      }
    }
    return { kind: "processing" };
  }

  if (issue.stateName === WATCHED_STATES.blocked) {
    if (newUserComments.length > 0) {
      return { kind: "resume", latestUserCommentId };
    }
    return { kind: "nothing", reason: "blocked, waiting for user reply" };
  }

  if (issue.stateName === WATCHED_STATES.active) {
    if (newUserComments.length > 0) {
      return { kind: "feedback", latestUserCommentId };
    }
    return { kind: "nothing", reason: "in-progress, no new activity" };
  }

  if (issue.stateName === WATCHED_STATES.review) {
    // A direct Linear reply takes precedence over forge review chatter.
    if (newUserComments.length > 0) {
      return { kind: "feedback", latestUserCommentId };
    }
    // The real decision needs the forge (open CR + CI + review comments).
    return { kind: "check-review" };
  }

  return { kind: "nothing", reason: `state "${issue.stateName}" is not watched` };
};
