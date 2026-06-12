# Porting meridian/ai-pipeline hardenings into gene

**Date:** 2026-06-12
**Status:** Approved design — ready for implementation planning

## Background

Gene (`src/`) is a fork of `wizecore/meridian`'s `scripts/ai-pipeline` — originally a
Trello-only, GitHub-only "Claude Code dispatch daemon." Gene has since diverged far ahead of
upstream: pluggable trackers (Linear + Trello, `src/tracker/`), pluggable forges (GitLab +
GitHub, `src/forge/`), forge CI/review-comment polling (`review.ts`), Postgres state + activity
log (`db.ts`), an OpenTUI dashboard (`src/ui/`), microsandbox isolation, inline agent retry with
exponential backoff and active-time-aware timeouts (`invoke.ts`, `timer.ts`).

A file-by-file comparison against the upstream copy in `meridian/scripts/ai-pipeline/` found that
most of meridian's hardening is **already present** in gene (drift + rebase guidance, parallel
spawns + concurrency cap, `fetchWithRetry`, colorized logs). The DollarDeploy lanes
(`deploy.ts`, `dollardeploy.ts`, the Testing-on-testing.welby.ch flow) are explicitly **out of
scope**. The meridian **planning protocol + subcards** feature is deliberately **deferred** (not
in this effort).

This spec covers the three remaining upstream hardenings worth bringing into gene, as three
independent, separately-shippable units, in implementation order.

## Guiding principle

Everything here respects gene's existing abstractions and adds **zero behavior change** unless a
new optional setting is configured:

- **States, not labels.** Gene models Trello *lists* as lifecycle states (identical to Linear
  workflow states) and uses the `Gene` label purely as an ownership tag; agent comments are
  detected via `GENE_AGENT_MARKER`, not a member identity. Meridian's `ai:blocked` / `ai:done` /
  `ai:working` labels are **not** reintroduced. The equivalent of meridian's "post a block" is a
  `moveToState(BLOCKED_STATE)` + comment.
- **Per-tracker / per-forge capabilities.** New backend-specific behavior is added behind the
  existing `Tracker` / `Forge` interfaces, not in the core flow.
- **Dry-run honored.** No new code performs a tracker/forge write when `GENE_DRY_RUN` is set.
- **Opt-in.** New env settings default to today's exact behavior.

---

## Feature 1 — Silent-crash + transient-API detection

### Problem

`claude -p` exits **0** even when its connection to Anthropic drops mid-stream, or it dies without
emitting its terminal `result`/`success` event. Gene's `invoke.ts` retries only on **non-zero**
exit codes (`isRetriable`), so an exit-0 run that never actually finished is recorded as
`agent-done`. `decide.ts` then returns `nothing` for an ACTIVE issue with no new comment, so the
issue stalls in `ACTIVE_STATE` indefinitely — never retried, never surfaced to a human.

Upstream references: meridian `invoke.ts` (`TRANSIENT_API_PATTERNS`, `sawSuccessResult`),
`index.ts` (`postSilentCrashBlock`, `postTransientFailureBlock`), `retry-state.ts`.

### Change

**`src/invoke.ts`:**
- In `runClaudeOnce`, additionally track:
  - `sawSuccessResult` — `true` once a `result` event with `subtype === "success"` is seen
    (`claude -p` emits exactly one per clean run; absence = the process died or exited mid-stream).
  - `transientFailure` / `transientReason` — set when an assistant **text** block matches a known
    transient-transport signature. Port meridian's `TRANSIENT_API_PATTERNS`
    (`/api error.*socket connection was closed/i`, `/econnreset/i`, `/upstream connect error/i`,
    `/fetch failed/i`, `/api error.*timeout/i`, etc.).
- Extend `isRetriable` so a run is retriable when **either** the exit code is non-zero (today's
  behavior, minus `error_max_turns`) **or** the exit code is 0 but the run was a silent crash
  (`!sawSuccessResult`) or transient (`transientFailure`). All retries stay within the existing
  `AGENT_MAX_RETRIES` budget and exponential backoff; the worktree persists across attempts so a
  retry resumes prior work. Operator-cancelled runs remain exempt (existing `monitor.isCancelled`
  guard).
- Enrich the return type to
  `InvokeResult = { kind; worktreePath; exitCode; sawSuccessResult; transientFailure; transientReason }`.
- Recording stays faithful: a final outcome that is a silent crash or transient-exhaustion is
  logged distinctly in the activity log (e.g. `agent-stalled`) rather than `agent-done`.

**`src/index.ts` (`dispatchAgent` result handler):**
- The `.then(result => …)` block (today only handles `"skipped"`) gains: when the final
  `InvokeResult` is a **silent crash** (`!sawSuccessResult`) or **transient exhaustion**
  (`transientFailure` after all retries), post a comment on the issue and `moveToState(BLOCKED_STATE)`.
  The comment explains the run stopped mid-flight, the worktree is preserved, and a reply
  re-dispatches a resume. A human reply then re-enters via `decide.ts` → `resume-from-block`,
  which resumes from the persisted worktree.
- This block is gated by `!env.DRY_RUN` and skipped for operator-cancelled runs.

### Notes / decisions

- **No persistent cross-scan retry counter** (meridian's `retry-state.ts`). Gene already retries
  inline within a single spawn up to `AGENT_MAX_RETRIES` (default 5), which subsumes meridian's
  cross-scan budget. After inline exhaustion we surface via BLOCKED rather than looping across
  scans.
- A deliberate agent block (it comments + moves to Blocked, then exits) **does** emit
  `result`/`success`, so it is *not* misclassified as a silent crash.

---

## Feature 2 — Auto-progress In-Review → Done on merge

### Problem

When a change request merges, `review.ts` `findOpenChangeRequest` returns `null` (it filters to
`state === "open"`), so `evaluateReview` is a no-op and the issue sits in `REVIEW_STATE` until a
human moves it. gene's README documents merge→Done as manual / out of scope. The forge layer
already exposes the needed signal: `ChangeRequestReview.state` includes `"merged"`.

Upstream reference: meridian `pr-tracker.ts` Behavior A (auto-move merged cards to Done).

### Change

**`src/config.ts`:**
- Add `DONE_STATE = optional(`${TP}DONE_STATE`)` (tracker-namespaced, like the other `*_STATE`
  values). **Unset ⇒ feature disabled** — preserves today's manual behavior exactly. No entry is
  added to `WATCHED_STATES` (Done is a terminal state the daemon does not scan).

**`src/review.ts`:**
- Add `findMergedChangeRequest(issue, comments, target, forge)` — reuses the same ref-resolution
  as `findOpenChangeRequest` (attachment → description → comments, matched to target by iid, then
  fallback to the issue branch) but returns the `ChangeRequestReview` when its `state === "merged"`
  (else `null`).

**`src/index.ts` (`processReview`):**
- When `env.DONE_STATE` is set, check merge **first**: if `findMergedChangeRequest` returns a CR,
  post a short comment (CR link + "merged — moving to Done") and `moveToState(env.DONE_STATE)`,
  `record` it, and return `true`. Otherwise fall through to the existing CI/comment watchdog
  (`evaluateReview`).
- Idempotent: an issue already in `DONE_STATE` is not in a watched state, so it is never
  re-scanned; the move is a one-time transition. Honors dry-run.

### Notes / decisions

- Gated by `DONE_STATE` per the approved decision (opt-in). No `GENE_AUTO_DONE` boolean needed —
  presence of the state name is the toggle.
- Subcard/parent auto-completion (meridian `pr-tracker.ts` Behavior B) is **out of scope** (it
  belongs to the deferred planning-protocol feature).

---

## Feature 3 — Trello webhook reactivity (per-tracker capability)

### Problem

Gene only polls (`runForever` → `await sleep(POLL_INTERVAL_MS)`), so a Trello edit waits up to a
full interval before the daemon reacts. Meridian dropped latency to seconds via a Trello webhook —
but it relied on a Next.js API route (`pages/api/.../trello-webhook.ts`) writing an inbox file that
a separate daemon process watched. Gene is a single standalone daemon, so it can signal
**in-process** with no inbox files.

Upstream references: meridian `inbox.ts`, `setup-webhook.ts`, `pages/api/ai-pipeline/trello-webhook.ts`.

### Change

**`src/tracker/index.ts` (interface):**
- Add an **optional** method to `Tracker`:
  ```ts
  /** Start reacting to backend activity in real time. Returns a stop function.
   *  Optional — a tracker without push support simply omits it (poll-only). */
  startWatch?(onActivity: () => void): Promise<() => void>;
  ```
  Generic and backend-neutral: Linear can implement it later (Linear webhooks); only Trello
  implements it now.

**`src/tracker/trello.ts` (`TrelloTracker.startWatch`):**
- No-op (resolves to a noop stop fn) unless `GENE_WEBHOOK_URL`, `TRELLO_API_SECRET`,
  `TRELLO_API_KEY`, and `TRELLO_TOKEN` are all present.
- **Register** the Trello webhook lazily on first start: list existing webhooks for the token,
  and `POST /webhooks` with `idModel = board`, `callbackURL = GENE_WEBHOOK_URL` if not already
  registered (port of `setup-webhook.ts`). Registration is a Trello-API concern, so it lives in
  the tracker; the core flow stays generic.
- Start a tiny `node:http` listener on `GENE_WEBHOOK_PORT`:
  - `HEAD` → 200 (Trello verifies the callback URL on registration).
  - `POST` → read the raw body, verify the `x-trello-webhook` HMAC-SHA1 signature
    (`HMAC(body + callbackURL, TRELLO_API_SECRET)`, `timingSafeEqual`), parse the action, and if
    its type is relevant (`commentCard`, `updateCard`, `createCard`, …) call `onActivity()` and
    respond 200. Invalid signature → 401; irrelevant action → 200 ignored.
- The returned stop function closes the HTTP server. (Webhook de-registration is left to the
  `gene:webhook --delete-all` CLI; an orphaned webhook against a downed tunnel is harmless and
  Trello disables it.)

**`src/index.ts` (`runForever` + `gracefulShutdown`):**
- If `tracker.startWatch` exists, call it once before the loop with an `onActivity` that resolves
  the current sleep early. Replace `await sleep(POLL_INTERVAL_MS)` with an **interruptible wait**:
  a promise that resolves on the poll timeout **or** when `onActivity` fires (then a short debounce
  before the immediate scan, mirroring `DEBOUNCE_MS`). This is the in-process analogue of
  meridian's `sleepUntilNextPoll` inbox watch.
- `gracefulShutdown` calls the stop function (best-effort) alongside closing the DB.

**`package.json` + a small CLI (`src/webhook.ts`):**
- `npm run gene:webhook` — port of `setup-webhook.ts`: default registers/lists; `--list`;
  `--delete-all`. Reuses the registration helpers from the Trello tracker (extracted so both the
  CLI and `startWatch` share one implementation).

### Config additions

| Env | Meaning | Default |
|---|---|---|
| `GENE_WEBHOOK_URL` | Public callback URL (e.g. a cloudflared tunnel) | unset ⇒ webhook off |
| `GENE_WEBHOOK_PORT` | Local port for the HTTP listener | `8473` |
| `TRELLO_API_SECRET` | Trello OAuth secret for HMAC verification | unset ⇒ webhook off |

When any required value is missing the daemon runs exactly as today (poll-only). The webhook is
strictly a latency optimization; correctness never depends on it.

---

## Config additions (summary)

All optional; every default preserves current behavior.

- `${TP}DONE_STATE` (e.g. `TRELLO_DONE_STATE` / `LINEAR_DONE_STATE`) — Feature 2.
- `GENE_WEBHOOK_URL`, `GENE_WEBHOOK_PORT`, `TRELLO_API_SECRET` — Feature 3.

`.env.example` and `README.md` updated to document each.

## Testing

gene has no test runner wired yet (`package.json` has only `typecheck`). The plan step will
confirm whether to add one (e.g. `node --test`) or keep verification to `npm run typecheck` plus a
dry-run smoke (`GENE_DRY_RUN=true npm run gene:once -- <ID>`). Pure logic to cover:

- **Feature 1:** transient/silent-crash classification (`isRetriable` + the text-pattern matcher)
  given representative stream events.
- **Feature 2:** `findMergedChangeRequest` returns the CR only for `state === "merged"`.
- **Feature 3:** HMAC signature verification accepts a correctly-signed body and rejects a tampered
  one; relevant-action filtering.

## Out of scope

- DollarDeploy / testing-lane deployment (`deploy.ts`, `dollardeploy.ts`).
- Planning protocol + Shape A/B subcards and parent auto-completion (meridian `682f168`,
  `pr-tracker.ts` Behavior B) — deferred to a future effort.
- Reintroducing Trello `ai:*` labels — gene's state model replaces them.

## Implementation order

Three independent phases, each its own commit/PR:

1. **Feature 1** — silent-crash + transient detection (`invoke.ts`, `index.ts`, config none).
2. **Feature 2** — auto-progress → Done (`config.ts`, `review.ts`, `index.ts`).
3. **Feature 3** — Trello webhook capability (`tracker/index.ts`, `tracker/trello.ts`, `index.ts`,
   `webhook.ts` CLI, `config.ts`, `package.json`).
