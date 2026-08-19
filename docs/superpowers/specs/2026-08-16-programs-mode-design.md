# Programs mode: recurring programs fired manually or by triggers

**Date:** 2026-08-16
**Status:** approved

## Problem

Gene turns a ticket into a change request: it watches for `Gene`-labelled issues in
`Todo`, runs a coding agent in a worktree, opens an MR/PR, and drives it to `Done`. Every
issue is **consumed once** by the workflow state machine (`src/index.ts` `scanOnce`,
`src/decide.ts` `decideAction`).

Some work is not a one-shot code change but a **recurring operation**: watch main-branch
CI in Linear and, when it goes red, research the failure and file a fix ticket; poll
DataDog through the `pup` CLI for suspicious 500s and open a ticket when they spike. These
run *from time to time*, produce a write-back (a comment, or new tickets) rather than a
pull request, and must be **ready to run again** — they are never "done".

Nothing in Gene models this. There is no non-consuming ticket type, no manual "run this
now" action, no scheduler/cron, and no DataDog/pup wiring (confirmed: the only recurring
machinery is the single `runForever` poll loop in `src/index.ts` and `POLL_INTERVAL_MS`).

## Approach

Add a **program**: a Linear/Trello ticket carrying a configurable `Program` label,
authored like any ticket but with the sections `## Trigger`, `## Workflow`,
`## Acceptance criteria`. A program is a **definition**; each execution is an ephemeral
**run**. Gene never moves a program to a terminal state — a run ends by writing back and
returning the ticket to rest.

The design reuses the existing loop wherever it already fits:

- **the active/blocked lifecycle** — a running program sits in `ACTIVE_STATE`
  (In Progress); if it needs a decision it moves to `BLOCKED_STATE` and resumes on a human
  `!gene approve` reply, exactly like `decide.ts`'s Blocked-resume + `directives.ts`;
- **section enforcement** — `decide.ts` `findMissingSections`, driven by a new
  `PROGRAM_REQUIRE_SECTIONS`;
- **run history** — `issue_log` (`src/db.ts`), with new event names;
- **the agent spawn** — `invoke.ts` `invokeAgent` / `runClaudeOnce`, with a program prompt
  intent and a repo-optional working dir;
- **a persistent per-item cursor** — a `program_state` table modelled on `review_cursor`
  (`src/review.ts` `readCursor` / `writeCursor`).

What is genuinely new: fetching programs by their own label, a manual-fire path from the
TUI, a no-change-request agent prompt, restoring the resting state on completion, and (a
later phase) turning `## Trigger` prose into event wiring.

### 1. The `Program` label and program fetch

Programs are discriminated by a **label**, so they never enter the coding-work queue even
when parked in `Todo`. Config, namespaced by tracker like every other key
(`src/config.ts`, `TP` prefix):

```
PROGRAM_LABEL             str(`${TP}PROGRAM_LABEL`, "Program")  # LINEAR_/TRELLO_PROGRAM_LABEL (tracker-namespaced)
PROGRAM_REQUIRE_SECTIONS  str("GENE_PROGRAM_REQUIRE_SECTIONS", "## Trigger,## Workflow,## Acceptance criteria")
PROGRAM_ALLOWED_TOOLS     str("GENE_PROGRAM_ALLOWED_TOOLS", "")  # e.g. Bash(pup *)
```

`PROGRAM_LABEL` is tracker-namespaced like `LABEL`; the section and tool keys are global
`GENE_*`, matching the existing `GENE_REQUIRE_SECTIONS` / `GENE_ALLOWED_TOOLS`.

The tracker `LIST_QUERY` already filters on a single label name
(`src/tracker/linear.ts`, `labels.name.eq $label`). Add a sibling `listPrograms(label)` to
the `Tracker` interface (`src/tracker/index.ts`) that runs the same query for
`PROGRAM_LABEL`, under the same assignee eligibility. A program may also carry `Gene`; it
does not matter — the program path owns any ticket with `PROGRAM_LABEL`, and `scanOnce`
excludes `PROGRAM_LABEL`-bearing issues from coding work so a ticket is never handled by
both.

### 2. Lifecycle and the scan pass

A new `scanPrograms` pass runs each poll alongside `scanOnce`. For every program it decides,
much like `decideAction`:

- **resting** (no in-flight run, no fire pending) → no-op. Gene ignores the program's
  workflow state while it rests.
- **fire requested** (manual now; triggered later) → record the current state as
  `resting_state` in `program_state`, post a start comment, move to `ACTIVE_STATE`, and
  dispatch the program agent under the per-issue lock (`withLock`).
- **blocked with a new human reply** → resume the run from its preserved context (same
  signal `decide.ts` uses: a non-marker human comment newer than Gene's last, plus the
  `!gene approve` / feedback directive).
- **run finished** → the agent has already written back; move the ticket from
  `ACTIVE_STATE` back to `resting_state` (**never `DONE_STATE`**) and record
  `program-run-done`.

Only **one run per program at a time**, guaranteed by the existing **file lock**
(`src/lock.ts` `withLock`), reused unchanged — programs dispatch through the same path,
keyed by the ticket identifier (`withLock(identifier, …)`). A second
fire while a run is in flight is a **restart**: cancel the current run (the existing cancel
path, `src/monitor.ts` / `app.ts` `armCancel`) and dispatch a fresh one.

**Lock vs. status — deliberately separate.** The *lock* is mutual exclusion only. It stays
a file lock because that lock is crash-safe for free: it records the owner PID + timestamp,
checks liveness (`process.kill(pid, 0)`), and auto-reclaims a stale lock (dead PID, or
older than `MAX_LOCK_AGE_MS`). A duplicate acquire returns `"skipped"` — the hook for the
restart path. A program's *lifecycle status* (idle / running / blocked, last-run time, last
result) is a different concern and lives in the DB (`program_state` + `issue_log`), which is
what the TUI and `scanPrograms` read. It is **not** used as the lock: a bare `status='running'`
row cannot tell whether the process that set it is alive, so a DB-status lock would have to
reinvent the PID-liveness + staleness reclaim the file lock already gives, and a crash would
leave a stale `running` wedging every future fire. The one case a DB lock would serve —
multiple daemons across hosts sharing one Postgres — Gene is not built for (default store is
single-process embedded PGlite); if it ever is, the clean swap is a Postgres advisory lock
(`pg_try_advisory_lock`) behind the same `withLock` seam, not a status column.

`program_state` (new table in `src/db.ts` `SCHEMA`, shaped after `review_cursor`):

```
program_state(tracker, identifier PRIMARY KEY parts, resting_state text,
              last_fired_at timestamptz, last_result text, last_source text)
```

`resting_state` is written at fire time and read back at completion, so a crash mid-run
does not lose where the ticket belongs. Interrupted program runs reconcile on startup the
same way coding runs do (`db.ts` `findInterruptedRuns`): the ticket is still in
`ACTIVE_STATE`, so the next `scanPrograms` re-picks it up from its preserved working dir.

### 3. The program agent

A new `PromptIntent: "program"` (`src/prompt.ts` `PromptIntent`, `intentInstructions`,
outcomes). Its instructions differ from a coding run in four ways:

- **execute `## Workflow`**, judging completion by `## Acceptance criteria`;
- **never open a change request** — no branch push, no `gh pr` / `glab mr`. This is stated
  as a hard rule, and the program path simply never calls `processReview` or the draft
  machinery;
- **write results back to this ticket** as a marked comment (`GENE_AGENT_MARKER`), via the
  `Bash(linear *)` the agent already has;
- **create child tickets when the workflow calls for it** — regular tickets carrying the
  `Gene` label (and a repo link) so the normal pipeline picks them up later (the "file a
  ticket to fix the flaky tests" example). Child tickets get `Gene`, never `PROGRAM_LABEL`,
  so a program cannot spawn programs. Logged as `child-ticket-created`. This mirrors the
  existing parent/child relationship in `src/subcards.ts`.

**Repo-optional.** If the program ticket carries a repo link, reuse `ensureWorktree`
(`src/invoke.ts`) as today. Otherwise run repo-less: a scratch working dir under `.gene`
(so attachments and scratch files still have a home) with no git worktree. `invoke.ts`
grows a "no worktree" branch for this; `getAgentArgs` keeps `--add-dir` on the scratch dir.

**Tools.** The base allowlist (`invoke.ts` `BASE_ALLOWED_TOOLS`, which already includes
`WebFetch`) plus `linear`, plus `PROGRAM_ALLOWED_TOOLS` for extras such as `Bash(pup *)`.
Forge CLIs (`gh`/`glab`) are granted when a program targets a repo, as today.

### 4. Plan-execution / clarification mode

Built on the existing plan-first rails (`prompt.ts` outcomes 1–2: propose a plan → move to
`BLOCKED_STATE` → exit; resume on `!gene approve`). Two levers:

- **always-can-stop** — the `program` prompt always permits a mid-run stop: if the agent
  determines the workflow needs serious changes or a decision, it comments, moves to
  Blocked, and exits, rather than guessing.
- **plan-first (opt-in)** — a program author requests "propose the plan and wait before
  executing" in the `## Workflow` prose; the prompt honours it. (A dedicated
  `Plan`-style label could formalise this later; prose needs no new config and matches the
  trigger model below.)

Resume is unchanged from coding runs: a human reply with `!gene approve` (or edits, or
`!gene stop`) drives `parseDirective` (`src/directives.ts`, vocab `approve|redo|stop|retry`)
and continues the run from its preserved working dir.

### 5. TUI (the Phase 1 user surface)

- **`src/ui/theme.ts`** — add a **⟳** program glyph and a program badge/colour to
  `palette`; run status keeps using the existing `statusGlyph` (running/blocked/done/error).
- **`src/ui/dashboard.ts`** — render programs inline, marked with ⟳ (`rowLine` / `Row`);
  add a filter toggle to show only programs, alongside the existing hide-done (`d`) toggle.
- **`src/ui/app.ts`** — a **fire/restart** action on a selected program row bound to `g`
  ("Go"), using the codebase's arm→confirm pattern (`armReset` / `armRemove` / `armFork`),
  because a fire costs a real `claude` run. It calls a new `fireProgram(id)` callback added
  to `StartUiOptions` and wired in `startUi` (`src/index.ts`) next to
  `reset` / `fork` / `removeFromGene`. `fireProgram` enqueues a fire request and wakes the
  poll (`wakePoll` / `requestScan`); `scanPrograms` dispatches it.
- **`src/ui/detail.ts`** — show `## Trigger` / `## Workflow` / `## Acceptance criteria` and
  the run history for the program from `issue_log` (`readIssueLog`).
- **`src/ui/header.ts`** — an optional programs count in the scan breakdown.

### 6. Observability

New `issue_log` events (surfaced by `npm run log` and the TUI history, same as every other
event): `program-fired` (with `source`: `manual` | `trigger`), `program-run-done` (with
`last_result`), `child-ticket-created`. Reuse `agent-start` / `agent-done` / `agent-error`
for the run itself. Optionally emit plugin events `program-fired` / `program-finished`
(`src/plugins/index.ts` `GeneEvent`) so the plugin system can observe programs — deferred
to Phase 3 unless a plugin needs it sooner.

### 7. Triggers (Phase 2 — direction only, specifics deferred)

`## Trigger` is authored in prose but is **not** re-evaluated by an agent every cadence.
Instead, when a program is armed for auto-fire, an agent reads the prose once and
**compiles it into event wiring** — registers a webhook on the source system, or a cron
entry — whose callback hits a **Gene ingress endpoint** that fires the program. Gene
already runs an inbound webhook listener for Trello (`GENE_WEBHOOK_URL` / `GENE_WEBHOOK_PORT`,
`src/webhook.ts` + `src/tracker/trello/webhook.ts`); the ingress extends it with a
`fire program <identifier>` route that enqueues a `program-fired` (`source: trigger`)
request into the same path manual fire uses. Cron-style triggers hit the same ingress on a
schedule. Concrete request/verification format, the compile step's prompt and tool set, and
the cron store are **to be detailed in the Phase 2 plan.**

## Phasing

- **Phase 1 (build now):** the `Program` label + `listPrograms` fetch; `scanPrograms`
  lifecycle (rest → In Progress → [Blocked → `!gene approve`] → restore); the `program`
  agent (repo-optional, no change request, comment write-back + child-ticket creation);
  plan/clarification mode; `PROGRAM_REQUIRE_SECTIONS` gate; config; `program_state` table;
  TUI (⟳ glyph, `g` fire/restart, programs filter, detail sections + run history); tests.
- **Phase 2 (later, specifics TBD):** trigger compilation (prose → webhook/cron) + the Gene
  ingress route that fires a program from an external callback + cadence.
- **Phase 3 (optional):** plugin events (`program-fired` / `program-finished`), a dedicated
  plan-mode label, richer trigger sources.

## Accepted limitations

- A program's workflow state is meaningful only while a run is in flight (In Progress /
  Blocked). At rest, a human dragging the program between columns has no effect — the
  `Program` label, not the column, defines it. Documented in the README.
- Restart cancels the current run; any partial write-back it already posted stays on the
  ticket (comments are not retracted). Acceptable — a run's comments are a log, not state.
- If a program targets no repo and its workflow nonetheless shells into git, it fails like
  any misconfigured ticket; repo-optional means *Gene* does not require a repo, not that the
  workflow cannot need one.
- Phase 1 has no scheduler: programs fire only from the TUI. Auto-fire waits for Phase 2.

## Testing

Against stub `Tracker` / `Forge` (no network), matching `src/*.test.ts` conventions:

- **section gate** — `findMissingSections` for the program sections: all present → none
  missing; each missing → reported.
- **scan routing** — a `PROGRAM_LABEL` ticket routes to the program path and is excluded
  from `scanOnce` coding work; a `Gene`-only ticket is untouched by `scanPrograms`.
- **lifecycle** — fire records `resting_state` and moves to `ACTIVE_STATE`; completion
  restores `resting_state` and never sets `DONE_STATE`; a Blocked program with a new
  `!gene approve` reply resumes; a second fire while running is a restart (cancel + redispatch).
- **prompt** — `buildPrompt` with intent `program` asserts the "never open a change
  request" rule and the write-back / child-ticket instructions are present, and that a
  coding intent still does not carry them.
- **manual fire plumbing** — `fireProgram(id)` enqueues a fire request and wakes the poll;
  `scanPrograms` dispatches exactly one run per request (no duplicate per poll).

Plus `npm run typecheck`, the full `npm test` suite, and a smoke run of the built binary
(TS runs under Node strip-only, so a passing typecheck does not prove it runs).

## Docs

- **`README.md`** — a "Programs" section: what a program is, the `Program` label, the three
  sections, manual fire (`g`) and the ⟳ marker, write-back vs change requests, and the
  resting-state caveat. Note Phase 2 triggers as coming.
- **`.gene.config.example`** and **`src/config.ts`** — document `*_PROGRAM_LABEL`,
  `GENE_PROGRAM_REQUIRE_SECTIONS`, `GENE_PROGRAM_ALLOWED_TOOLS`.
