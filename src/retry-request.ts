/**
 * Operator-requested retries — the TUI's `r` inside a ticket. A retry re-dispatches
 * the agent in the ticket's existing worktree without a new tracker comment (the
 * usual trigger), e.g. after a run died on an expired login. The poll loop consumes
 * a request the next time it sees the ticket (see processIssue in index.ts).
 * Dependency-free so it can be unit tested without the tracker / Postgres.
 */

const pendingRetries = new Set<string>();

/** Queue a retry for a ticket (idempotent per identifier). */
export const requestRetry = (identifier: string): void => {
  pendingRetries.add(identifier.toLowerCase());
};

/** Remove and report a pending retry, so each request dispatches at most once. */
export const takeRetryRequest = (identifier: string): boolean => pendingRetries.delete(identifier.toLowerCase());
