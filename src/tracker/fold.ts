/**
 * Folding old comments away once a program run ends, so a program ticket that runs every
 * day reads as its description, its newest comment and its sub-issues — not a scroll of
 * every past run. Folding resolves a comment *thread* (Linear collapses resolved threads;
 * they stay readable, so a workflow can still look back at an earlier run's report).
 */

/** The parts of a comment that folding needs. `parentId` is null for a thread's root. */
export type ThreadComment = {
  id: string;
  createdAt: string;
  parentId: string | null;
  resolved: boolean;
};

const time = (iso: string): number => Date.parse(iso);

/**
 * Root ids of the threads to fold once a run that started at `cutoffIso` ends: every
 * unresolved thread whose comments all predate the run. A thread with a comment from the
 * run itself stays open, and so does the thread holding the ticket's newest comment —
 * even a run that posted nothing leaves the latest word visible.
 */
export const threadsToFold = (comments: ThreadComment[], cutoffIso: string): string[] => {
  if (comments.length === 0) return [];
  const cutoff = time(cutoffIso);
  const rootOf = (comment: ThreadComment): string => comment.parentId ?? comment.id;
  const newest = comments.reduce((a, b) => (time(b.createdAt) > time(a.createdAt) ? b : a));

  const keep = new Set<string>([rootOf(newest)]);
  for (const comment of comments) {
    if (time(comment.createdAt) >= cutoff) keep.add(rootOf(comment));
  }
  return comments
    .filter(comment => comment.parentId === null && !comment.resolved && !keep.has(comment.id))
    .sort((a, b) => time(a.createdAt) - time(b.createdAt))
    .map(comment => comment.id);
};
