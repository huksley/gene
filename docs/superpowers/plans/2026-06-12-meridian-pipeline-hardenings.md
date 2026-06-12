# meridian/ai-pipeline Hardenings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port three independent, opt-in hardenings from `wizecore/meridian`'s `scripts/ai-pipeline` into gene — silent-crash/transient detection, auto-progress to Done on merge, and Trello webhook reactivity — without reintroducing meridian's label model or DollarDeploy.

**Architecture:** Each feature is a separate phase with its own commit(s). Pure classification logic is extracted into small, dependency-light modules so it is unit-testable in isolation (gene's heavy modules transitively import the tracker singleton + Postgres). Backend-specific behavior (the webhook) is added behind the existing `Tracker` interface as an optional capability. Every new setting is optional and defaults to today's exact behavior.

**Tech Stack:** TypeScript executed directly by Node (v24+, native type-stripping), Node's built-in test runner (`node --test`), `pg`, `chalk`, `node:http`/`node:crypto`. Spec: `docs/superpowers/specs/2026-06-12-meridian-pipeline-hardenings-design.md`.

---

## Conventions for every task

- **Run tests:** `node --test 'src/**/*.test.ts'` (the single-quoted glob is expanded by Node, scoping it to `src/`; bare `node --test` wrongly crawls into the cloned `repos/`).
- **Typecheck:** `npm run typecheck` → expected `exit 0`, no errors. This is the gating check for every task that touches `.ts`.
- **Imports use explicit `.ts` specifiers** (e.g. `import { env } from "./config.ts"`) — match the existing files.
- **Branch:** all work lands on `feat/meridian-hardenings` (already checked out).
- **Commits** end with the trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## File structure

| File | Phase | Responsibility |
|---|---|---|
| `src/agent-retry.ts` | 1 | **NEW.** Pure: transient-API text patterns + the `isRetriable` predicate. No heavy imports → unit-testable. |
| `src/agent-retry.test.ts` | 1 | **NEW.** Unit tests for the above. |
| `src/invoke.ts` | 1 | **MODIFY.** Track `sawSuccessResult` + transient failure in the stream; use the new `isRetriable`; enrich `InvokeResult`. |
| `src/index.ts` | 1,2,3 | **MODIFY.** Block on stalled runs (1); auto-Done on merge (2); start the tracker watch + interruptible poll wait (3). |
| `src/config.ts` | 2,3 | **MODIFY.** Add `DONE_STATE` (2); `WEBHOOK_URL`, `WEBHOOK_PORT`, `TRELLO_API_SECRET` (3). |
| `src/review.ts` | 2 | **MODIFY.** Extract `resolveChangeRequest(predicate)`; add `findMergedChangeRequest`. |
| `src/tracker/index.ts` | 3 | **MODIFY.** Add optional `startWatch?` to the `Tracker` interface. |
| `src/tracker/trello-webhook.ts` | 3 | **NEW.** Webhook resource: REST register/list/delete + HMAC verify + relevant-action filter + `node:http` listener. |
| `src/tracker/trello-webhook.test.ts` | 3 | **NEW.** Unit tests for HMAC verify + action filter. |
| `src/tracker/trello.ts` | 3 | **MODIFY.** Implement `startWatch` via the webhook resource. |
| `src/webhook.ts` | 3 | **NEW.** `npm run webhook` CLI (register/list/delete). |
| `package.json` | 1,3 | **MODIFY.** Add `test` (1) and `webhook` (3) scripts. |
| `.env.example`, `README.md` | 3 | **MODIFY.** Document the new settings. |

---

# Phase 1 — Silent-crash + transient-API detection

## Task 1: Pure retry-classification module + tests

**Files:**
- Modify: `package.json` (add `test` script)
- Create: `src/agent-retry.ts`
- Test: `src/agent-retry.test.ts`

- [ ] **Step 1: Add the `test` script to `package.json`**

In the `"scripts"` block, add a `test` entry next to `typecheck`:

```json
    "typecheck": "tsc --noEmit",
    "test": "node --test 'src/**/*.test.ts'"
```

- [ ] **Step 2: Write the failing test** — `src/agent-retry.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesTransient, isRetriable } from "./agent-retry.ts";

test("matchesTransient flags known dropped-socket / API-transport signatures", () => {
  assert.equal(matchesTransient("API Error: socket connection was closed unexpectedly"), true);
  assert.equal(matchesTransient("request failed with ECONNRESET"), true);
  assert.equal(matchesTransient("TypeError: fetch failed"), true);
  assert.equal(matchesTransient("upstream connect error or disconnect"), true);
});

test("matchesTransient ignores ordinary assistant prose", () => {
  assert.equal(matchesTransient("I fixed the failing test and opened the PR."), false);
  assert.equal(matchesTransient("The socket module needs a refactor."), false);
});

test("isRetriable: turn-limit is never retried", () => {
  assert.equal(isRetriable(1, "error_max_turns", false), false);
  assert.equal(isRetriable(0, "error_max_turns", false), false);
});

test("isRetriable: any non-zero exit retries (unless turn-limit)", () => {
  assert.equal(isRetriable(1, "error", false), true);
  assert.equal(isRetriable(-1, undefined, false), true);
});

test("isRetriable: clean exit-0 success does NOT retry", () => {
  assert.equal(isRetriable(0, "success", false), false);
});

test("isRetriable: exit-0 silent crash (no success result) retries", () => {
  assert.equal(isRetriable(0, undefined, false), true);
});

test("isRetriable: exit-0 with a transient signature retries", () => {
  assert.equal(isRetriable(0, "success", true), true);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test 'src/**/*.test.ts'`
Expected: FAIL — `Cannot find module './agent-retry.ts'` (the module does not exist yet).

- [ ] **Step 4: Implement** — `src/agent-retry.ts`

```ts
/**
 * Pure agent-run retry classification, kept dependency-free so it can be unit
 * tested without pulling in the tracker singleton / Postgres that `invoke.ts`
 * transitively imports.
 *
 *  - `matchesTransient` recognises assistant text that signals the model API
 *    connection itself failed at the transport layer (a dropped socket mid-run),
 *    as opposed to a tool error. `claude -p` exits 0 in this case even though the
 *    work didn't finish, so we must detect it from the stream text.
 *  - `isRetriable` decides whether a finished run should be spawned again within
 *    the retry budget — covering both non-zero crashes and the deceptive exit-0
 *    "didn't actually finish" cases (silent crash / transient drop).
 */

/** Signatures in assistant text that mean the API transport dropped, not a tool failure. */
export const TRANSIENT_API_PATTERNS: RegExp[] = [
  /api error.*socket connection was closed/i,
  /api error.*connection.*closed/i,
  /api error.*network/i,
  /api error.*timeout/i,
  /econnreset/i,
  /upstream connect error/i,
  /fetch failed/i
];

/** True when `text` contains a known transient-transport signature. */
export const matchesTransient = (text: string): boolean =>
  TRANSIENT_API_PATTERNS.some(pattern => pattern.test(text));

/**
 * Should a finished run be retried (within the AGENT_MAX_RETRIES budget)?
 *
 *  - The turn-limit (`error_max_turns`) is never retried — a re-run burns the
 *    same budget to the same wall.
 *  - Any non-zero exit is a crash/transient error → retry.
 *  - Exit 0 normally means "done", EXCEPT when the run didn't truly finish:
 *    a transient API drop was seen mid-stream, or the CLI never emitted its
 *    terminal `result`/`success` event (`resultSubtype !== "success"`).
 */
export const isRetriable = (
  exitCode: number,
  resultSubtype: string | undefined,
  transientFailure: boolean
): boolean => {
  if (resultSubtype === "error_max_turns") {
    return false;
  }
  if (exitCode !== 0) {
    return true;
  }
  return transientFailure || resultSubtype !== "success";
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test 'src/**/*.test.ts'`
Expected: PASS — `tests 7  pass 7  fail 0`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add package.json src/agent-retry.ts src/agent-retry.test.ts
git commit -m "$(cat <<'EOF'
feat: pure agent-retry classifier (transient + silent-crash)

Extract transient-API text patterns and the isRetriable predicate into a
dependency-free module so they're unit-testable without the tracker/DB
import graph. Adds a `test` script (node --test, scoped to src/).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

## Task 2: Wire detection into `invoke.ts`

**Files:**
- Modify: `src/invoke.ts`

- [ ] **Step 1: Import the classifier and drop the local `isRetriable`**

Replace the local definition at `src/invoke.ts:284-296` (the `isRetriable` doc-comment + arrow function) with nothing, and add to the import block near the top (after the `chalk` import, line 30):

```ts
import { isRetriable, matchesTransient } from "./agent-retry.ts";
```

(The `KILL_GRACE_MS`, `SANDBOX_SCRIPT` consts that followed `isRetriable` stay where they are.)

- [ ] **Step 2: Enrich the `InvokeResult` type**

Replace `src/invoke.ts:87`:

```ts
export type InvokeResult = { kind: "spawned" | "dry-run"; worktreePath: string; exitCode: number };
```

with:

```ts
export type InvokeResult = {
  kind: "spawned" | "dry-run";
  worktreePath: string;
  exitCode: number;
  /** True when a terminal `result`/`success` event was seen — a clean finish. */
  sawSuccessResult: boolean;
  /** True when the agent's stream showed a transient API/transport drop. */
  transientFailure: boolean;
  /** First transient error text seen (truncated), for the surfaced comment. */
  transientReason: string | null;
};
```

- [ ] **Step 3: Track transient failure inside `runClaudeOnce`**

In `runClaudeOnce` (the `new Promise(...)` body), add two locals next to `let timedOut = false;` (around `src/invoke.ts:383`):

```ts
    let timedOut = false;
    let transientFailure = false;
    let transientReason: string | null = null;
```

In the `lines.on("line", ...)` handler, immediately after `const event = JSON.parse(line) as StreamEvent;` and the existing `if (event.type === "result") { ... }` block (around `src/invoke.ts:454-458`), add a scan of assistant text blocks:

```ts
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === "text" && typeof block.text === "string" && matchesTransient(block.text)) {
              transientFailure = true;
              transientReason ??= block.text.slice(0, 300);
              logger.warn(`${logger.tag.invoke} [${issue.identifier}] transient API error in stream: ${truncate(block.text)}`);
            }
          }
        }
```

Extend the `runClaudeOnce` return type and both `resolve(...)` payloads to carry the new fields. Update the return-type annotation (around `src/invoke.ts:371-378`) to include:

```ts
    timedOut: boolean;
    transientFailure: boolean;
    transientReason: string | null;
    events: AgentEvent[];
```

and the `proc.on("exit", ...)` resolve (around `src/invoke.ts:483-486`):

```ts
    proc.on("exit", code => {
      clearTimers();
      resolve({
        exitCode: code ?? -1,
        resultSubtype,
        resultText,
        durationMs,
        timedOut,
        transientFailure,
        transientReason,
        events
      });
    });
```

- [ ] **Step 4: Thread the new fields through `invokeAgent`'s retry loop**

Add the two trackers to the `let` block (around `src/invoke.ts:520-526`):

```ts
  let timedOut = false;
  let transientFailure = false;
  let transientReason: string | null = null;
  let attemptsMade = 0;
  let events: AgentEvent[] = [];
```

Update the destructuring assignment from `runClaudeOnce` (around `src/invoke.ts:540-547`):

```ts
    ({ exitCode, resultSubtype, resultText, durationMs, timedOut, transientFailure, transientReason, events } =
      await runClaudeOnce(issue, prompt, worktreePath, allowedTools, childEnv, updatePid));
```

Update the retry-break condition (around `src/invoke.ts:566`):

```ts
    if ((!timedOut && !isRetriable(exitCode, resultSubtype, transientFailure)) || attempt === totalAttempts) {
      break;
    }
```

- [ ] **Step 5: Classify the final outcome (stalled) and enrich the return**

Just before the final-outcome recording (around `src/invoke.ts:580-581`, after `const summary = ...`), compute:

```ts
  const sawSuccessResult = resultSubtype === "success";
  const stalled = exitCode === 0 && (transientFailure || !sawSuccessResult);
```

In the recording branch, insert a `stalled` case between the `cancelled` and `exitCode === 0` branches (around `src/invoke.ts:583-600`):

```ts
  } else if (stalled) {
    await recordAgent(
      "agent-stalled",
      `ended without a clean result after ${seconds}s` +
        `${transientFailure ? " (transient API drop)" : " (no success result)"}${summary}`,
      events
    );
    monitor.agentFinished(id, "error", durationMs);
  } else if (exitCode === 0) {
```

Replace the two `return { kind: "spawned", ... }` / `{ kind: "dry-run", ... }` statements to include the new fields. The dry-run early return (around `src/invoke.ts:500-506`):

```ts
  if (env.DRY_RUN) {
    logger.info(
      `${logger.tag.invoke} [${id}] (dry-run) would spawn ${agentLabel} in ${worktreePath} ` +
      `(prompt ${prompt.length} chars, ${allowedTools.length} tools)`
    );
    return { kind: "dry-run", worktreePath, exitCode: 0, sawSuccessResult: true, transientFailure: false, transientReason: null };
  }
```

The final return (around `src/invoke.ts:609`):

```ts
  return { kind: "spawned", worktreePath, exitCode, sawSuccessResult, transientFailure, transientReason };
```

- [ ] **Step 6: Typecheck + run tests**

Run: `npm run typecheck` → expected exit 0.
Run: `node --test 'src/**/*.test.ts'` → expected `pass 7 fail 0` (unchanged; this task is integration glue).

- [ ] **Step 7: Commit**

```bash
git add src/invoke.ts
git commit -m "$(cat <<'EOF'
feat: detect silent-crash + transient API drops in agent runs

invoke.ts now scans the agent stream for transient-transport signatures
and tracks whether a terminal success result was seen. Exit-0 runs that
didn't truly finish are retried within the existing budget and reported
as `agent-stalled` instead of `agent-done`.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

## Task 3: Surface stalled runs in the daemon

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import the result type**

Update the invoke import (around `src/index.ts:30`) to add `type InvokeResult`:

```ts
import { ensureWorktree, invokeAgent, worktreePathFor, type ExistingChangeRequest, type InvokeResult } from "./invoke.ts";
```

- [ ] **Step 2: Add the stalled-block helpers**

Insert just above `processReview` (around `src/index.ts:405`, after `dispatchAgent` closes):

```ts
/** Comment body for a run that stalled (transient API drop or silent crash). */
const buildStalledComment = (result: InvokeResult): string => {
  const why = result.transientFailure
    ? "my connection to the model API dropped mid-run"
    : "my run ended without producing a final result (the agent exited mid-flight)";
  return [
    `🧬 I stopped before finishing — ${why}.`,
    "",
    "Nothing is broken: the worktree is preserved with whatever I'd already done. " +
      "**Reply here** (e.g. \"go ahead\" or \"retry\") and I'll resume from where I left off.",
    result.transientReason ? `\nLast error seen: \`${result.transientReason.slice(0, 200)}\`` : ""
  ]
    .filter(Boolean)
    .join("\n");
};

/**
 * A run exited 'cleanly' (code 0) but never finished — a dropped API socket or a
 * silent crash. Post an explanatory comment and move the issue to BLOCKED so a
 * human sees it and a reply re-dispatches a resume, instead of the issue silently
 * stalling in ACTIVE_STATE (decideAction returns `nothing` for it). Best-effort.
 */
const postStalledBlock = async (issue: Issue, result: InvokeResult): Promise<void> => {
  try {
    await tracker.postComment(issue, buildStalledComment(result));
    await tracker.moveToState(issue, env.BLOCKED_STATE);
    await record(
      issue,
      "stalled",
      result.transientFailure ? "transient API drop — moved to Blocked" : "silent crash (no success result) — moved to Blocked"
    );
    logger.warn(`${logger.tag.flow} [${issue.identifier}] run stalled — posted block, moved to "${env.BLOCKED_STATE}"`);
  } catch (error) {
    logger.error(
      `${logger.tag.flow} [${issue.identifier}] failed to post stalled block:`,
      error instanceof Error ? error.message : error
    );
  }
};
```

- [ ] **Step 3: Inspect the spawn result in `dispatchAgent`**

Replace the spawn promise's `.then(result => { ... })` (around `src/index.ts:372-376`):

```ts
    .then(async result => {
      if (result === "skipped") {
        logger.info(`${logger.tag.flow} [${issue.identifier}] another run holds the lock — skipping`);
        return;
      }
      // Silent crash / transient exhaustion: exited code 0 but never produced a
      // success result, or dropped the API socket mid-stream. Surface it.
      const stalled = result.exitCode === 0 && (result.transientFailure || !result.sawSuccessResult);
      if (stalled && !monitor.isCancelled(issue.identifier)) {
        await postStalledBlock(issue, result);
      }
    })
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck` → expected exit 0. (Fix the deliberate typo note from Step 2 if tsc flags it.)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat: surface stalled agent runs as Blocked + comment

When a run exits 0 without a clean result (silent crash) or after a
transient API drop, the daemon now posts an explanatory comment and moves
the issue to BLOCKED so a human reply resumes it from the worktree —
instead of the issue silently stalling in the active state.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

# Phase 2 — Auto-progress In-Review → Done on merge

## Task 4: `DONE_STATE` config + `findMergedChangeRequest`

**Files:**
- Modify: `src/config.ts`
- Modify: `src/review.ts`

- [ ] **Step 1: Add `DONE_STATE` to config**

In `src/config.ts`, in the `env` object after the `REVIEW_STATE` line (`src/config.ts:124`), add:

```ts
  REVIEW_STATE: str(`${TP}REVIEW_STATE`, "In Review"),
  // Terminal state to auto-move an In-Review issue into once its change request
  // merges. Unset ⇒ disabled (merge→Done stays a manual human step). Tracker-
  // namespaced like the other *_STATE values. NOT in WATCHED_STATES — Done is
  // terminal and never scanned.
  DONE_STATE: optional(`${TP}DONE_STATE`),
```

- [ ] **Step 2: Refactor `review.ts` ref-resolution to take a predicate, add `findMergedChangeRequest`**

Replace `findOpenChangeRequest` (`src/review.ts:97-130`) with a shared resolver plus two thin wrappers:

```ts
/**
 * Resolve the change request for an issue and return the first one matching
 * `accept`. Prefers an MR/PR attached/linked to the issue (tracker attachment →
 * description → comments, matched to the target repo by iid, so a human branch
 * name is fine); falls back to an MR/PR on the issue's own branch. Null if none
 * matches.
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
```

(`ChangeRequestReview` is already imported in `review.ts:31`. `Comment`, `Issue`, `RepoTarget`, `Forge`, `findChangeRequestRefs`, `refMatchesTarget`, `tracker`, `logger` are all already imported.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` → expected exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/review.ts
git commit -m "$(cat <<'EOF'
feat: add findMergedChangeRequest + optional DONE_STATE

Generalises review.ts ref-resolution behind a predicate so open- and
merged-CR lookups share one walk, and adds an opt-in ${TP}DONE_STATE
setting (unset = today's manual merge→Done behaviour).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

## Task 5: Auto-move merged issues to Done in `processReview`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import `findMergedChangeRequest`**

Update the review import (around `src/index.ts:32`):

```ts
import { evaluateDraftPickup, evaluateReview, findMergedChangeRequest, writeCursor, type ReviewContext } from "./review.ts";
```

- [ ] **Step 2: Check for a merged CR first in `processReview`**

At the top of `processReview` (around `src/index.ts:418`, right after the function opens and before `let outcome;`), insert:

```ts
  // When DONE_STATE is configured, a merged change request ends the lifecycle:
  // move the issue to Done and stop — no point polling CI on a merged CR.
  if (env.DONE_STATE) {
    let merged;
    try {
      merged = await findMergedChangeRequest(issue, comments, target, forge);
    } catch (error) {
      logger.warn(
        `${logger.tag.flow} [${issue.identifier}] merged-CR check failed:`,
        error instanceof Error ? error.message : error
      );
      merged = null;
    }
    if (merged) {
      logger.info(`${logger.tag.flow} [${issue.identifier}] ${merged.url} merged — moving to "${env.DONE_STATE}"`);
      await record(issue, "merged", `${merged.url} merged → ${env.DONE_STATE}`);
      try {
        await tracker.postComment(
          issue,
          `🧬 ${forge.changeRequestTerm} merged (${merged.url}) — moving this to **${env.DONE_STATE}**.`
        );
        await tracker.moveToState(issue, env.DONE_STATE);
      } catch (error) {
        logger.error(
          `${logger.tag.flow} [${issue.identifier}] failed to move to "${env.DONE_STATE}":`,
          error instanceof Error ? error.message : error
        );
      }
      return true;
    }
  }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` → expected exit 0.

- [ ] **Step 4: (Optional) dry-run smoke**

If a Trello/Linear tracker + a real In-Review issue with a merged CR is configured locally:
Run: `GENE_DRY_RUN=true <TP>_DONE_STATE=Done npm run gene:once -- <ISSUE-ID>`
Expected: a log line `… merged — moving to "Done"` and `(dry-run) would move … → "Done"`, no actual writes.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat: auto-progress In-Review issues to Done on merge

When ${TP}DONE_STATE is set, processReview checks for a merged change
request first and moves the issue to the Done state with a comment,
instead of leaving it parked in review.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

# Phase 3 — Trello webhook reactivity

## Task 6: Config + interface + webhook resource (with tests)

**Files:**
- Modify: `src/config.ts`
- Modify: `src/tracker/index.ts`
- Create: `src/tracker/trello-webhook.ts`
- Test: `src/tracker/trello-webhook.test.ts`

- [ ] **Step 1: Add webhook config**

In `src/config.ts`, add the Trello secret next to the other `TRELLO_*` reads (after `TRELLO_TOKEN`, `src/config.ts:107`):

```ts
  TRELLO_TOKEN: optional("TRELLO_TOKEN"),
  // Trello OAuth secret (distinct from the user token) used to verify webhook
  // HMAC signatures. From trello.com/power-ups/admin under your API key.
  TRELLO_API_SECRET: optional("TRELLO_API_SECRET"),
```

And add the daemon-level webhook settings near `POLL_INTERVAL_MS` (after `src/config.ts:145`):

```ts
  DEBOUNCE_MS: int("GENE_DEBOUNCE_MS", 30_000),
  // Public callback URL Trello calls (e.g. a cloudflared tunnel pointing at the
  // local listener). Unset ⇒ webhook disabled, poll-only. Must be the EXACT URL
  // registered with Trello (it is part of the HMAC the signature is verified against).
  WEBHOOK_URL: optional("GENE_WEBHOOK_URL"),
  // Local port the webhook HTTP listener binds (your tunnel forwards here).
  WEBHOOK_PORT: int("GENE_WEBHOOK_PORT", 8473),
```

- [ ] **Step 2: Add the optional `startWatch` capability to the `Tracker` interface**

In `src/tracker/index.ts`, inside the `Tracker` interface (after `allowedTools(): string[];`, `src/tracker/index.ts:87`):

```ts
  /** Extra `--allowedTools` entries the agent needs for this backend (e.g. `Bash(trello *)`). */
  allowedTools(): string[];

  /**
   * Optionally start reacting to backend activity in real time (a webhook), so the
   * daemon can wake before the next poll. Calls `onActivity` on each relevant event
   * and resolves to a stop function. A poll-only tracker omits this entirely.
   */
  startWatch?(onActivity: () => void): Promise<() => void>;
```

- [ ] **Step 3: Write the failing test** — `src/tracker/trello-webhook.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyTrelloSignature, isRelevantTrelloAction } from "./trello-webhook.ts";

const sign = (body: string, callbackUrl: string, secret: string): string =>
  crypto.createHmac("sha1", secret).update(body + callbackUrl).digest("base64");

test("verifyTrelloSignature accepts a correctly-signed body", () => {
  const body = JSON.stringify({ action: { type: "commentCard" } });
  const url = "https://tunnel.example/gene";
  const secret = "s3cret";
  assert.equal(verifyTrelloSignature(body, url, sign(body, url, secret), secret), true);
});

test("verifyTrelloSignature rejects a tampered body", () => {
  const url = "https://tunnel.example/gene";
  const secret = "s3cret";
  const sig = sign(JSON.stringify({ action: { type: "commentCard" } }), url, secret);
  assert.equal(verifyTrelloSignature(JSON.stringify({ action: { type: "updateCard" } }), url, sig, secret), false);
});

test("verifyTrelloSignature rejects a wrong secret", () => {
  const body = "{}";
  const url = "https://tunnel.example/gene";
  assert.equal(verifyTrelloSignature(body, url, sign(body, url, "right"), "wrong"), false);
});

test("verifyTrelloSignature rejects garbage without throwing", () => {
  assert.equal(verifyTrelloSignature("{}", "https://x", "not-base64-of-right-length", "s"), false);
});

test("isRelevantTrelloAction filters to card-activity types", () => {
  assert.equal(isRelevantTrelloAction("commentCard"), true);
  assert.equal(isRelevantTrelloAction("updateCard"), true);
  assert.equal(isRelevantTrelloAction("createCard"), true);
  assert.equal(isRelevantTrelloAction("updateBoard"), false);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test 'src/**/*.test.ts'`
Expected: FAIL — `Cannot find module './trello-webhook.ts'`.

- [ ] **Step 5: Implement** — `src/tracker/trello-webhook.ts`

```ts
/**
 * Trello webhook resource for the Trello tracker. Kept separate from trello.ts so
 * that file stays focused on the issue/state mapping. Two concerns:
 *
 *  - **Registration** (REST): list/create/delete the board webhook against a public
 *    callback URL (a tunnel). Shared by `TrelloTracker.startWatch` and the
 *    `npm run webhook` CLI.
 *  - **Listening**: a tiny node:http server that verifies Trello's HMAC-SHA1
 *    signature, filters to card activity, and calls `onActivity` to wake the daemon.
 *
 * `verifyTrelloSignature` / `isRelevantTrelloAction` are pure and unit-tested.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import crypto from "node:crypto";
import logger from "../logger.ts";
import { env } from "../config.ts";
import { fetchRetryTimeout } from "../fetch.ts";

const API_BASE = "https://api.trello.com/1";

/** Trello action types worth waking the daemon for (card-scoped activity). */
const RELEVANT_ACTIONS = new Set([
  "commentCard",
  "updateCard",
  "createCard",
  "addMemberToCard",
  "removeMemberFromCard"
]);

/** True when a Trello action type is one we want to react to. */
export const isRelevantTrelloAction = (type: string): boolean => RELEVANT_ACTIONS.has(type);

/** Verify Trello's webhook signature: base64(HMAC-SHA1(body + callbackURL, secret)). */
export const verifyTrelloSignature = (
  body: string,
  callbackUrl: string,
  signature: string,
  secret: string
): boolean => {
  const expected = crypto.createHmac("sha1", secret).update(body + callbackUrl).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    // timingSafeEqual throws on length mismatch — treat as invalid.
    return false;
  }
};

const auth = (): string => `key=${env.TRELLO_API_KEY}&token=${env.TRELLO_TOKEN}`;

export type TrelloWebhook = {
  id: string;
  description: string;
  idModel: string;
  callbackURL: string;
  active: boolean;
};

/** All webhooks registered against the current Trello token. */
export const listTrelloWebhooks = async (): Promise<TrelloWebhook[]> => {
  const res = await fetchRetryTimeout(`${API_BASE}/tokens/${env.TRELLO_TOKEN}/webhooks?${auth()}`);
  if (!res.ok) {
    throw new Error(`Trello list webhooks -> ${res.status}`);
  }
  return (await res.json()) as TrelloWebhook[];
};

export const createTrelloWebhook = async (idModel: string, callbackURL: string): Promise<TrelloWebhook> => {
  const res = await fetchRetryTimeout(`${API_BASE}/webhooks/?${auth()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idModel, callbackURL, description: "Gene AI pipeline (auto-registered)" })
  });
  if (!res.ok) {
    throw new Error(`Trello create webhook -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TrelloWebhook;
};

export const deleteTrelloWebhook = async (id: string): Promise<void> => {
  const res = await fetchRetryTimeout(`${API_BASE}/webhooks/${id}?${auth()}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`Trello delete webhook ${id} -> ${res.status}`);
  }
};

/** Register the board webhook against `callbackUrl` if not already present (idempotent). */
export const ensureTrelloWebhook = async (idModel: string, callbackUrl: string): Promise<void> => {
  const existing = await listTrelloWebhooks();
  if (existing.some(w => w.idModel === idModel && w.callbackURL === callbackUrl)) {
    logger.info(`[trello-webhook] already registered → ${callbackUrl}`);
    return;
  }
  const created = await createTrelloWebhook(idModel, callbackUrl);
  logger.info(`[trello-webhook] registered (id=${created.id}, active=${created.active}) → ${callbackUrl}`);
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });

/**
 * Start the webhook HTTP listener. HEAD → 200 (Trello verifies the URL on
 * registration); POST → verify signature, filter the action, call `onActivity`.
 * Returns a stop function that closes the server.
 */
export const startTrelloWebhookListener = (opts: {
  port: number;
  callbackUrl: string;
  secret: string;
  onActivity: () => void;
}): (() => void) => {
  const server: Server = createServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    void readBody(req)
      .then(body => {
        const signature = String(req.headers["x-trello-webhook"] ?? "");
        if (!verifyTrelloSignature(body, opts.callbackUrl, signature, opts.secret)) {
          logger.warn("[trello-webhook] signature verification failed");
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200).end();
        try {
          const parsed = JSON.parse(body) as { action?: { type?: string } };
          const type = parsed.action?.type ?? "";
          if (isRelevantTrelloAction(type)) {
            logger.info(`[trello-webhook] ${type} — waking poll loop`);
            opts.onActivity();
          }
        } catch {
          /* malformed body — already 200'd, nothing to wake on */
        }
      })
      .catch(() => {
        res.writeHead(400).end();
      });
  });
  server.on("error", error =>
    logger.error("[trello-webhook] listener error:", error instanceof Error ? error.message : error)
  );
  server.listen(opts.port, () => logger.info(`[trello-webhook] listening on :${opts.port}`));
  return () => {
    try {
      server.close();
    } catch {
      /* already closed */
    }
  };
};
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test 'src/**/*.test.ts'`
Expected: PASS — `pass 12 fail 0` (7 from Task 1 + 5 here).

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck` → expected exit 0.

```bash
git add src/config.ts src/tracker/index.ts src/tracker/trello-webhook.ts src/tracker/trello-webhook.test.ts
git commit -m "$(cat <<'EOF'
feat: Trello webhook resource + optional Tracker.startWatch

Adds a per-tracker startWatch capability and the Trello webhook resource
(REST register/list/delete, HMAC-SHA1 verification, action filter, node:http
listener). Pure verify/filter helpers are unit-tested. Config gains
GENE_WEBHOOK_URL, GENE_WEBHOOK_PORT, TRELLO_API_SECRET (all optional).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

## Task 7: Implement `TrelloTracker.startWatch`

**Files:**
- Modify: `src/tracker/trello.ts`

- [ ] **Step 1: Import the webhook resource**

Add to `src/tracker/trello.ts` imports (after the trello client type import, `src/tracker/trello.ts:30`):

```ts
import { ensureTrelloWebhook, startTrelloWebhookListener } from "./trello-webhook.ts";
```

- [ ] **Step 2: Add `startWatch` to the `TrelloTracker` class**

Append a method after `allowedTools()` (around `src/tracker/trello.ts:370-372`):

```ts
  allowedTools(): string[] {
    return ["Bash(node *)"];
  }

  /**
   * Real-time reactivity via a Trello board webhook. Disabled (poll-only) unless
   * GENE_WEBHOOK_URL + TRELLO_API_SECRET (and the API key/token) are set. Registers
   * the webhook if missing, then starts the HTTP listener; returns a stop function.
   * Registration failure is non-fatal — the daemon keeps polling.
   */
  async startWatch(onActivity: () => void): Promise<() => void> {
    const noop = (): void => {};
    if (!env.WEBHOOK_URL || !env.TRELLO_API_SECRET || !env.TRELLO_API_KEY || !env.TRELLO_TOKEN) {
      logger.info("[trello] webhook disabled (set GENE_WEBHOOK_URL + TRELLO_API_SECRET to enable) — poll-only");
      return noop;
    }
    try {
      await ensureTrelloWebhook(boardId(), env.WEBHOOK_URL);
    } catch (error) {
      logger.warn(
        "[trello] could not register webhook (continuing poll-only):",
        error instanceof Error ? error.message : error
      );
      return noop;
    }
    return startTrelloWebhookListener({
      port: env.WEBHOOK_PORT,
      callbackUrl: env.WEBHOOK_URL,
      secret: env.TRELLO_API_SECRET,
      onActivity
    });
  }
```

(`boundId`/`boardId` and `logger`, `env` are already in scope in `trello.ts`.)

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` → expected exit 0.

```bash
git add src/tracker/trello.ts
git commit -m "$(cat <<'EOF'
feat: TrelloTracker.startWatch — register + listen for webhooks

Implements the optional startWatch capability for Trello: registers the
board webhook against GENE_WEBHOOK_URL and starts the listener. No-op
(poll-only) when the webhook env isn't configured.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

## Task 8: Wire early-wake into the daemon loop

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Module-level handle for the watch stop function**

Near the other module-level state (after `const inFlight = ...`, around `src/index.ts:168`), add:

```ts
/** Stop function for the active tracker watch (webhook listener), if started. */
let stopWatch: (() => void) | null = null;
```

- [ ] **Step 2: Replace the fixed sleep with an interruptible wait, and start the watch**

In `runForever` (around `src/index.ts:586-613`), restructure: start the watch before the loop and swap `await sleep(...)` for a promise that resolves on the timeout OR an early-wake signal. Replace the body from the heartbeat setup through the loop:

```ts
  // Surface in-flight agents between scans on the same cadence as the poll loop;
  // unref() so the heartbeat alone never holds the process open at shutdown.
  const heartbeat = setInterval(reportInFlight, env.POLL_INTERVAL_MS);
  heartbeat.unref();

  // Optional real-time reactivity: if the tracker supports a watch (e.g. a Trello
  // webhook), let it wake the current poll wait early. Poll-only when unsupported.
  let wakeEarly: (() => void) | null = null;
  if (tracker.startWatch) {
    try {
      stopWatch = await tracker.startWatch(() => wakeEarly?.());
    } catch (error) {
      logger.warn(`${logger.tag.flow} could not start tracker watch:`, error instanceof Error ? error.message : error);
    }
  }

  while (true) {
    try {
      const found = await scanOnce(issueFilter);
      if (!found) {
        logger.info(
          `${logger.tag.flow} issue "${issueFilter}" not found among ${env.LABEL} issues yet — ` +
          `waiting (next poll in ${Math.round(env.POLL_INTERVAL_MS / 1000)}s)`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${logger.tag.flow} scan failed:`, message, { cause: error });
      monitor.scanFailed(message);
    }
    // Wait for the poll interval, but wake immediately if the tracker watch signals
    // activity. The per-issue debounce (isWithinDebounceWindow) still defers work on
    // a just-edited issue to the following cycle, so an early wake can't act too soon.
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        wakeEarly = null;
        resolve();
      }, env.POLL_INTERVAL_MS);
      wakeEarly = () => {
        clearTimeout(timer);
        wakeEarly = null;
        logger.info(`${logger.tag.flow} woken early by tracker activity`);
        resolve();
      };
    });
  }
```

- [ ] **Step 3: Remove the now-unused `sleep` helper**

Delete the `const sleep = (ms: number)...` line (`src/index.ts:566`). It was only used by the loop above. (The `--once` path uses `Promise.allSettled`, not `sleep`.)

- [ ] **Step 4: Stop the watch on shutdown**

In `gracefulShutdown` (around `src/index.ts:622`), at the very top of the function body add:

```ts
export const gracefulShutdown = async (signal: string): Promise<void> => {
  if (stopWatch) {
    try {
      stopWatch();
    } catch {
      /* listener already closed */
    }
    stopWatch = null;
  }
  const owned = listOwnedLocks();
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck` → expected exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat: wake the poll loop early on tracker webhook activity

runForever now starts tracker.startWatch (when present) and waits on an
interruptible timer that the webhook can resolve early, dropping reaction
latency from a full poll interval to seconds. gracefulShutdown stops the
listener. Falls back to plain polling when no watch is available.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

## Task 9: Webhook management CLI + docs

**Files:**
- Create: `src/webhook.ts`
- Modify: `package.json`
- Modify: `.env.example`, `README.md`

- [ ] **Step 1: Implement the CLI** — `src/webhook.ts`

```ts
/**
 * One-shot CLI to manage the Trello board webhook.
 *
 *   npm run webhook                 # register against GENE_WEBHOOK_URL (idempotent), then list
 *   npm run webhook -- --list       # just list webhooks on this token/board
 *   npm run webhook -- --delete-all # delete every webhook on this board
 *
 * Requires GENE_TRACKER=trello, TRELLO_BOARD, TRELLO_API_KEY, TRELLO_TOKEN; the
 * register path additionally needs GENE_WEBHOOK_URL (your public tunnel URL).
 */

import logger from "./logger.ts";
import { env } from "./config.ts";
import { listTrelloWebhooks, ensureTrelloWebhook, deleteTrelloWebhook } from "./tracker/trello-webhook.ts";

const main = async (): Promise<void> => {
  if (env.TRACKER !== "trello") {
    logger.error("[webhook] only the Trello tracker supports webhooks (set GENE_TRACKER=trello)");
    process.exit(1);
  }
  if (!env.TRELLO_BOARD) {
    logger.error("[webhook] TRELLO_BOARD is required");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const existing = await listTrelloWebhooks();
  const onBoard = existing.filter(w => w.idModel === env.TRELLO_BOARD);
  logger.info(`[webhook] ${existing.length} webhook(s) on token; ${onBoard.length} on board ${env.TRELLO_BOARD}`);
  for (const w of onBoard) {
    logger.info(`[webhook]   - ${w.id} → ${w.callbackURL} (active=${w.active})`);
  }

  if (args.includes("--list")) {
    return;
  }
  if (args.includes("--delete-all")) {
    for (const w of onBoard) {
      logger.info(`[webhook] deleting ${w.id}…`);
      await deleteTrelloWebhook(w.id);
    }
    return;
  }
  if (!env.WEBHOOK_URL) {
    logger.error("[webhook] GENE_WEBHOOK_URL is required to register (start a tunnel, e.g. cloudflared)");
    process.exit(1);
  }
  await ensureTrelloWebhook(env.TRELLO_BOARD, env.WEBHOOK_URL);
};

main().catch(error => {
  logger.error("[webhook] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 2: Add the `webhook` script to `package.json`**

Next to `"trello": ...` in `"scripts"`:

```json
    "trello": "node --env-file-if-exists=.env.development trello/cli.ts",
    "webhook": "node --env-file-if-exists=.env.development src/webhook.ts",
```

- [ ] **Step 3: Document the settings in `.env.example`**

Add a section (Trello tracker area) documenting:

```
# --- Trello webhook (optional, low-latency reactivity) ---
# Public URL Trello calls; point a tunnel (e.g. `cloudflared tunnel --url http://localhost:8473`)
# at the local listener and put the printed https URL here. Unset = poll-only.
# GENE_WEBHOOK_URL=https://your-tunnel.trycloudflare.com
# GENE_WEBHOOK_PORT=8473
# Trello OAuth secret (trello.com/power-ups/admin, under your API key) for HMAC verification.
# TRELLO_API_SECRET=

# --- Auto-progress to Done on merge (optional) ---
# Name of the terminal state/list to move an In-Review issue into once its MR/PR merges.
# Unset = merge→Done stays manual. Tracker-namespaced (TRELLO_/LINEAR_).
# TRELLO_DONE_STATE=Done
# LINEAR_DONE_STATE=Done
```

- [ ] **Step 4: Document in `README.md`**

Under the lifecycle/config section, add a short note that (a) when `<TP>_DONE_STATE` is set, merged change requests auto-move the issue to that state; and (b) the optional Trello webhook (`GENE_WEBHOOK_URL` + `TRELLO_API_SECRET`, registered with `npm run webhook`) wakes the daemon within seconds instead of waiting a full poll. Mention silent-crash/transient runs now surface as Blocked with a "reply to resume" comment.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck` → expected exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/webhook.ts package.json .env.example README.md
git commit -m "$(cat <<'EOF'
feat: `npm run webhook` CLI + docs for the new settings

Adds the Trello webhook management CLI (register/list/delete) and documents
DONE_STATE, GENE_WEBHOOK_URL/PORT, and TRELLO_API_SECRET in .env.example
and the README.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] `npm run typecheck` → exit 0.
- [ ] `node --test 'src/**/*.test.ts'` → `pass 12 fail 0`.
- [ ] `git log --oneline feat/meridian-hardenings` shows the spec commit + 9 feature commits.
- [ ] (Optional, with real creds) `GENE_DRY_RUN=true npm run gene:once -- <ID>` runs without writes; `npm run webhook -- --list` lists webhooks.

## Notes for the implementer

- **Do not** reintroduce Trello `ai:blocked`/`ai:done`/`ai:working` labels — gene models state via lists, and the "block" is a `moveToState(BLOCKED_STATE)`.
- **Do not** touch `meridian/` (it is the untracked upstream reference copy) or anything DollarDeploy-related.
- The three phases are independent; if a phase is descoped, the earlier phases still stand on their own.
- gene executes TypeScript directly, so there is no build step — `npm run typecheck` is the compile gate.
```