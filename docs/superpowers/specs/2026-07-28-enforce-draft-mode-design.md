# Enforce draft mode after an agent run

**Date:** 2026-07-28
**Status:** approved

## Problem

`GENE_DRAFT_CHANGE_REQUEST=true` is documented as "a hard human gate" (README), but it
is advisory only. It shapes the agent's prompt in three places — `prompt.ts` (`draftHandling`),
`forge/github.ts` and `forge/gitlab.ts` (`promptSnippet`) — and nothing verifies the outcome.

An agent defeats the gate silently by:

- omitting `--draft` from `gh pr create`;
- dropping GitLab's `Draft:` title prefix (the only thing GitLab reads as "draft") while
  editing the title;
- running `gh pr ready` / `glab mr update --ready` despite being told not to.

Both forge CLIs are broadly allowlisted (`Bash(gh *)` / `Bash(glab *)`), so the agent's
ability to un-draft cannot be revoked at the tool level. The gate has to be enforced
after the fact.

## Approach

After an agent run completes, read the issue's open change request and, if it is not a
draft, force it back to draft.

### 1. Forge capability

Add to the `Forge` interface:

```ts
/** Force the change request back to draft. Returns false when the forge refused. */
markDraft(repo: RepoTarget, iid: string): Promise<boolean>;
```

- **GitHub:** `gh pr ready <iid> -R <repoPath> --undo`, with `GH_HOST` set for enterprise
  hosts (existing `ghEnv` helper).
- **GitLab:** `glab mr update <iid> --draft -R <repoPath>`, with `GITLAB_HOST`. glab
  re-applies the `Draft:` title prefix server-side, which is what GitLab reads.

Returns `res.code === 0`; never throws.

### 2. `src/draft.ts`

One purpose: hold a change request in draft.

```ts
/** True when this change request has escaped draft and can be pushed back. */
export const needsRedraft = (review: ChangeRequestReview | null | undefined): boolean;

/** Force `review` back to draft. Returns a log detail when it acted, null otherwise. */
export const redraft = (
  review: ChangeRequestReview | null | undefined,
  target: RepoTarget,
  forge: Forge
): Promise<string | null>;
```

`needsRedraft` is pure: `review != null && review.state === "open" && !review.isDraft`.
It does not read config, so the env gate lives at the call site.

`redraft` calls `markDraft`, then re-reads through `getReviewByIid` to confirm the flip
stuck, and warns loudly when it did not (a private repo on a plan without draft PRs, or
a PR in a merge queue, cannot be re-drafted). Returns the detail string only when the
change request is confirmed back in draft, so the activity log never claims an
enforcement that did not happen.

### 3. Hook point

In `dispatchAgent`'s post-run continuation (`index.ts`), gated on
`env.DRAFT_CHANGE_REQUEST` so draft mode being off costs zero extra API calls:

- runs after any *completed* run, including errored and cancelled ones — an agent that
  un-drafts and then crashes is exactly the case to catch;
- skipped when `result === "skipped"` (another run holds the per-issue lock and will run
  its own pass on finish);
- wrapped in try/catch — enforcement can never fail a run;
- follow-up watchdog dispatches (failing CI, new review comments) reuse `dispatchAgent`,
  so they are covered by the same hook.

Not enforced on every poll, deliberately: outside the window right after a run, a
non-draft change request is the *human* having marked it ready, which is the point of
draft mode. Continuous enforcement would fight the reviewer.

### 4. Observability

A warning line in the daemon log plus a `draft-enforced` event in `issue_log` (surfaced
by `npm run log` and the TUI history). No comment on the change request or the ticket —
this is a guardrail firing, not news for reviewers, and every Gene-authored CR comment is
one more thing the review watchdog has to filter as its own.

## Accepted limitations

- An agent that un-drafts and whose run never completes in this daemon (daemon killed
  mid-run) is not caught until the next dispatch for that issue.
- Narrow race: a human who marks the PR ready *while* the agent is still running has that
  action undone when the run finishes. Acceptable — draft mode means the ready transition
  happens after Gene is done with the ticket.

## Testing

`src/draft.test.ts`, against a stub `Forge` (no network):

- `needsRedraft` truth table: open non-draft → true; open draft, merged, closed, null → false.
- `redraft` calls `markDraft` exactly once for an open non-draft CR and returns a detail.
- `redraft` is a no-op returning `null` for a CR already in draft.
- `redraft` returns `null` when `markDraft` fails, and when the verify read shows the CR
  is still not a draft.

Plus `npm run typecheck`, the full `npm test` suite, and a smoke run of the built binary
(TS runs under Node strip-only, so typecheck passing does not prove it runs).

## Docs

Update `README.md`'s "Draft mode is a hard human gate" bullet and the
`GENE_DRAFT_CHANGE_REQUEST` comment in `.gene.config.example` and `src/config.ts` to say
the gate is enforced after each run, not merely requested.
