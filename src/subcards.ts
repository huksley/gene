/**
 * Parent auto-completion for Shape B work (subcards).
 *
 * When the agent splits a non-trivial card into independently-shippable subcards, each
 * subcard records its parent via the neutral {@link Issue.parentIdentifier} (Linear's
 * native sub-issue link / Trello's `Parent: <url>` description marker). Each subcard then
 * runs through the normal pipeline and lands in the Done state once its change request
 * merges (handled by processReview in index.ts).
 *
 * This module closes the loop: once EVERY subcard of a parent has reached the Done state,
 * the parent is moved to Done too. It runs once at the end of each scan over the issue
 * list the scan already fetched — no extra tracker calls for discovery, no `gh pr view`
 * polling, no checklist resolution (gene already auto-moves merged issues to Done).
 *
 * The decision logic ({@link parentsToComplete}, {@link isParentAwaitingChildren}) is pure
 * and unit-tested; {@link completeFinishedParents} is the thin side-effectful wrapper.
 */

import { env } from "./config.ts";
import { logEvent } from "./db.ts";
import logger from "./logger.ts";
import monitor from "./monitor.ts";
import { tracker, type Issue } from "./tracker/index.ts";

/** A parent and the resolved subcards that reference it. */
export type ParentCompletion = {
  parent: Issue;
  children: Issue[];
};

/** Subcards in `issues` that reference `parentIdentifier`. */
const childrenOf = (issues: Issue[], parentIdentifier: string): Issue[] =>
  issues.filter(i => i.parentIdentifier === parentIdentifier);

/**
 * Decide which parents are ready to auto-complete: their subcards are all in `doneState`.
 * Pure — takes the already-fetched issue list, returns the parents to move (with their
 * children, for the summary comment). A parent qualifies only when:
 *   - it is resolvable in `issues` (a dangling parentIdentifier is left for a human),
 *   - it is not already in `doneState`,
 *   - it has at least one child, and every child is in `doneState`.
 */
export const parentsToComplete = (issues: Issue[], doneState: string): ParentCompletion[] => {
  const parentIds = new Set<string>();
  for (const i of issues) {
    if (i.parentIdentifier) {
      parentIds.add(i.parentIdentifier);
    }
  }

  const out: ParentCompletion[] = [];
  for (const parentIdentifier of parentIds) {
    const parent = issues.find(i => i.identifier === parentIdentifier);
    if (!parent || parent.stateName === doneState) {
      continue;
    }
    const children = childrenOf(issues, parentIdentifier);
    if (children.length === 0) {
      continue;
    }
    if (children.every(c => c.stateName === doneState)) {
      out.push({ parent, children });
    }
  }
  return out;
};

/**
 * Whether `issue` is a parent that still has at least one subcard not yet in `doneState`.
 * The scan loop uses this to avoid re-dispatching a parent that's parked waiting on its
 * children (e.g. a human comments on it while the subcards are still in flight).
 */
export const isParentAwaitingChildren = (issue: Issue, issues: Issue[], doneState: string): boolean => {
  const children = childrenOf(issues, issue.identifier);
  return children.length > 0 && children.some(c => c.stateName !== doneState);
};

/** A `- [shortLink](url)` bullet per subcard, for the parent's completion comment. */
const summarize = (children: Issue[]): string =>
  children.map(c => `- ✅ [${c.identifier}](${c.url})`).join("\n");

/**
 * Move every parent whose subcards are all done to the Done state, with a summary comment.
 * No-op unless GENE_<TP>_DONE_STATE is configured (without a Done state there's nowhere to
 * move a parent). Each parent is handled independently — one failure never blocks the rest.
 */
export const completeFinishedParents = async (issues: Issue[]): Promise<void> => {
  const doneState = env.DONE_STATE;
  if (!doneState) {
    return;
  }

  for (const { parent, children } of parentsToComplete(issues, doneState)) {
    logger.info(
      `${logger.tag.flow} [${parent.identifier}] all ${children.length} subcard(s) done — moving to "${doneState}"`
    );
    await logEvent({
      tracker: tracker.name,
      identifier: parent.identifier,
      event: "parent-complete",
      detail: env.DRY_RUN
        ? `(dry-run) would move parent ${parent.identifier} to "${doneState}" (${children.length} subcards done)`
        : `parent ${parent.identifier} moved to "${doneState}" (${children.length} subcards done)`
    });
    try {
      await tracker.postComment(
        parent,
        `🧬 All ${children.length} subcard(s) are merged/done — moving this to **${doneState}**.\n\n${summarize(children)}`
      );
      await tracker.moveToState(parent, doneState);
      monitor.setIssueState(parent.identifier, doneState);
      monitor.markIssueDone(parent.identifier);
    } catch (error) {
      logger.error(
        `${logger.tag.flow} [${parent.identifier}] failed to auto-complete parent:`,
        error instanceof Error ? error.message : error,
        { cause: error }
      );
    }
  }
};
