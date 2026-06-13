# 🧬 Gene AI

AI agent which gets work done.
From ticket to pull request in minutes, without touching a code.


```
   ┌──────────┐        ┌─────────────┐       ┌───────────┐       ┌──────────┐
   │ Todo     │ ─────► │ In Progress │ ────► │ In Review │ ────► │ Done     │
   │ (plan)   │ ─────► │   (code)    │ ────► │  (push)   │ ────► │ (merge)  │
   └──────────┘        └─────────────┘       └───────────┘       └──────────┘
    pick up              │   ▲                │   ▲  │   merged
    + comment            │   │                │   └──┘
                    plan │   │ reply          │        re-dispatch loop:
                         ▼   │                │        CI failed, comment, or review
                      ┌──────┴──────┐         │
                      │   Blocked   │ ◄───────┘
                      └─────────────┘   needs a human decision
```

Gene AI watches your issue tracker — **Linear** or **Trello** — for issues labelled
**`Gene`**, and for each one dispatches a `claude` agent — running in a dedicated git
worktree — to do the work and open a change request. Each issue chooses its own target
repo (and the assigned forge) from a link in the issue, so one tracker can drive
**GitLab** and **GitHub** repos side by side.

## How it works

```
                 ┌──────────────────────────── GeneAI (this repo, orchestrator) ──────┐
   Tracker       │                                                                    │
  ┌───────┐ poll │  index.ts ─ scan ─► decide.ts ─► dispatch                          │
  │ Gene  │◄─────┤     │                                  │                           │
  │ label │      │     │ list issues (tracker api)        │ withLock(ISSUE-ID)        │
  └───────┘      │     ▼                                  ▼                           │ 
                 │  tracker/                         invoke.ts ── spawn ──► claude -p │
                 │                                        │  (in a worktree)          │
                 └────────────────────────────────────────┼───────────────────────────┘
                                                          │ git worktree off the clone
                               ┌──────────────────────────▼──────────────────────────┐
   GitLab / GitHub             │  repos/<repoPath>/                 (local clone)    │
  ┌──────────────┐  glab / gh  │  repos/.worktrees/<repoPath>/<ISSUE-ID> (per issue) │
  │ MR / PR      │◄────────────┤  the agent edits, commits, pushes, opens the MR/PR, │
  └──────────────┘             │  comments + moves the tracker state itself          │
                               └─────────────────────────────────────────────────────┘
```

The **orchestrator** only lists issues, decides, posts a start comment, moves the
issue to *In Progress*, and holds a per-issue lock. The **spawned agent** does
everything else — code changes, the merge/pull request, and the tracker write-back
(comments + the terminal state move).

## Flow in detail

One shortcut not on the flow above: a **Todo** issue that already has an MR/PR
attached skips the fresh start and **continues that draft** straight into the
In Review loop.

**Each scan** (every poll, or woken early by a webhook / TUI `r`) drains active work
before picking up anything new:

```
   ┌────────────────────────────────────────────────────────┐
   │ list your "Gene" issues, then act in PRIORITY ORDER:   │
   ├────────────────────────────────────────────────────────┤
   │ 1. In Progress / Blocked  → new human comment? resume  │
   │ 2. In Review              → check forge CI + comments  │
   │ 3. Todo                   → start new work (last)      │
   └────────────────────────────────────────────────────────┘
```

**What "dispatch the agent" does** — the orchestrator sets up and spawns; the agent
does the work and writes everything back itself:

```
   under a per-issue lock (ISSUE-ID):
   ┌──────────────────────────────────────────────────────────┐
   │ clone repo → git worktree → build prompt → spawn claude  │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼   then the AGENT itself:
   ┌──────────────────────────────────────────────────────────┐
   │ edit → commit → push → open / update the MR/PR           │
   │       → comment on the ticket → move its state           │
   └──────────────────────────────────────────────────────────┘
```

**If something breaks** — a hard kill never wedges an issue:

```
   daemon killed mid-run    log ends at "agent-start", no outcome → mark it
                            "interrupted"; next scan resumes it (still In
                            Progress, worktree kept)
   lock held by dead PID    reclaimed automatically on the next dispatch
   agent stalled / crashed  retried; if still unfinished → Blocked, with a
                            "reply to resume" comment
```

## Lifecycle (tracker workflow states)

The lifecycle is driven by the tracker's **workflow states** — Linear workflow states,
or on Trello the card's **list** (the daemon scans by state *name*, so both look alike):

| Phase | Mechanism |
|---|---|
| Eligible | label `Gene`, **assigned to you**, **and** state `Todo` |
| Picked up | orchestrator → **In Progress**, start comment, lock taken |
| Picked up — change request already attached | agent **continues** the open MR/PR (on its own branch) instead of starting fresh |
| Agent asks a question / proposes a plan | agent comments + → **Blocked** |
| Agent opens a change request | agent comments (MR/PR link) + → **In Review** (as a **draft** if `GENE_DRAFT_CHANGE_REQUEST`) |
| CI fails, **or** a reviewer comments | daemon re-dispatches the agent to address it (back to **In Review**) — a reviewer comment acts **even while CI is still running** |
| Human merges | manual → **Done** — or set `<TP>_DONE_STATE` to auto-move on merge |

The `Gene` label is an **ownership tag and is never removed by the pipeline.**
Each scan watches `Gene` issues in **{Todo, In Progress, Blocked, In Review}** and
handles ongoing work — active conversations (In Progress / Blocked) and open change
requests (In Review) — *before* picking up new Todo work.

**Assignee filter.** Gene only works issues **assigned to you** — the tracker user it
is authenticated as. Issues with the `Gene` label assigned to someone else (or
unassigned) are skipped and logged. Set the assignee filter (`LINEAR_ASSIGNEE` /
`TRELLO_ASSIGNEE`) to `any` to drop it, or to a specific user — Linear by email, Trello
by username — to work on their behalf (default: `me`).

**Agent vs human comments.** Gene posts as your own tracker user (both backends do),
so author identity can't tell them apart. Every comment Gene writes carries a marker
(`GENE_AGENT_MARKER`, default `#gene-ai`); `decide.ts` treats marker-bearing
comments as Gene's, and a human comment newer than Gene's last one is the trigger
to resume / handle feedback.

**Ignored comments (`ignore.ts`).** Some comments shouldn't count as a trigger —
slash/bang commands meant for another bot (`/review`), or a tracker's own status
chatter. Patterns to ignore are set per source — `LINEAR_`/`TRELLO_IGNORE_COMMENTS`
for issue comments, `GITLAB_`/`GITHUB_IGNORE_COMMENTS` for review comments on the
MR/PR — as a comma-separated list where each item is a case-insensitive **substring**
or a `/regexp/flags` (full test; commas inside the slashes are kept). Built-ins are
always on — `!review` and `/review` everywhere, plus `Review` on Linear — and your
patterns add to them. A matching issue comment isn't treated as new human feedback;
a matching review comment neither re-dispatches the agent nor reaches its prompt.
(Substrings are broad — `Review` also matches "please review" — so anchor a `/…/`
to narrow if needed.)

**In-Review handling (`review.ts`).** Once a change request is open, the daemon
polls the forge for two signals before it touches new Todo work: a **failing
pipeline / Actions run**, and **new review comments** on the MR/PR (the same
marker tells Gene's own replies from a human's). On either, it re-dispatches the
agent to push a fix and reply. A **new human comment is acted on immediately —
even while CI is still running**, so a reviewer never has to wait for a pipeline
to finish to be heard. Running CI only defers the cases where it logically must:
a still-running pipeline can't be a *failure* yet, and a draft pickup with nothing
new won't pile a fresh run onto mid-flight CI. With no new signal at all, the scan
is a no-op and the daemon moves on. A per-issue cursor (the handled head SHA +
newest comment, stored in Postgres via `db.ts`) ensures each signal triggers
exactly one dispatch, not one per poll.

**Auto-progress to Done on merge (`review.ts`, opt-in).** Set `<TP>_DONE_STATE`
(e.g. `TRELLO_DONE_STATE=Done` / `LINEAR_DONE_STATE=Done`) and the daemon moves an
In-Review issue to that state — with a comment — as soon as its change request
merges, instead of waiting for a human to drag it across. Left unset, merge→Done
stays a manual step (the default).

**Stalled runs surface as Blocked.** `claude -p` exits `0` even if its connection
to the model API drops mid-stream or it dies before emitting a final result. The
daemon detects both (a transient-transport signature in the stream, or a missing
success result), retries within the agent's retry budget, and — if it still didn't
finish — posts a "I stopped before finishing — reply to resume" comment and moves
the issue to **Blocked** rather than letting it stall silently In Progress. The
worktree is preserved, so a reply resumes from where it left off.

**Interrupted runs recover on restart (`index.ts`, `db.ts`).** If the daemon itself
is killed while an agent is mid-run — a hard quit, a crash, a reboot — that run
never records an outcome; its activity log just ends at `agent-start`. On the next
startup the daemon **reconciles** these: it writes a closing `agent-interrupted`
event for each (so the run stops haunting the dashboard as a stale in-flight row,
shown there as the `interrupted` status), and — because the issue is still **In
Progress** — the very next scan re-picks it up and continues from the preserved
worktree. The per-issue file lock is self-healing (it records the owning PID, and a
lock held by a now-dead process is reclaimed on the next dispatch), so a hard kill
never wedges an issue.

**Low-latency reactivity (optional Trello webhook).** By default the daemon reacts
within `GENE_POLL_INTERVAL_MS`. On Trello you can drop that to seconds: set
`GENE_WEBHOOK_URL` (a public tunnel pointing at the local listener on
`GENE_WEBHOOK_PORT`, default `8473`) plus `TRELLO_API_SECRET`, register the board
webhook with `npm run webhook`, and board activity wakes the poll loop immediately.
It's a per-tracker capability (`Tracker.startWatch`); without it the daemon just
polls — correctness never depends on the webhook.

**Draft pickup (`review.ts`).** If a Todo issue **already has an open change
request** — a human opened a **draft** MR/PR and handed it to Gene, or a previous
run opened one — Gene **continues** it instead of starting from scratch. It finds
the change request from the issue's tracker attachments (then description, then
comments), matched to the resolved repo and looked up by number — so it works even
when the MR/PR lives on a **human-named branch**, not an auto-linked one.
The agent checks out *that* branch, reads the diff, the CI result and any review
comments, addresses the pipeline failures / feedback below, finishes whatever the
change request is still missing, and — once the work is complete and CI is green —
marks the draft **ready for review** and moves the issue to **In Review** (or back
to **Blocked** if it needs a decision). With `GENE_DRAFT_CHANGE_REQUEST` set, it
leaves the draft as-is for a human to mark ready instead. This is the same machinery as In-Review
handling, just with "there's queued work here" rather than "wait for a new signal".

**Activity log (`db.ts`).** Alongside the review cursor, the daemon records a
per-issue **activity log** in the state store, keyed by `(tracker, issue id)`:
each dispatch, the agent's start / finish (with its own final summary), review
re-dispatches, draft pickups, and resets (dry-run entries are flagged). Inspect one
issue's history with `npm run log -- <system>:<id>` (e.g. `linear:CLOUD-1094`; a bare
id defaults the system to `GENE_TRACKER`). The store is a real Postgres, so a
one-shot command (`log` / `reset`) reads it fine while the daemon is running — both
just point at the same server (the local one on port 5433 by default).

## Repo targeting (per issue)

An issue declares its target repo simply by including a **GitLab or GitHub link**
in its description — the **first** such link wins (comments are checked as a
fallback). From the link Gene derives:

- **the forge** — from the host: `gitlab.*` → `glab`, `github.com` → `gh`;
- **the repo** — the project / `owner/repo` path (GitLab nested groups supported);
- **a monorepo subdir** — from a `…/tree/<branch>/<path>` deep link, if present;
  the agent is told to scope its changes to that subdirectory;
- **the base branch** — the `<branch>` in a `/tree/` link, else the repo's default.

```
https://gitlab.com/example/example-repo                                   → gitlab, whole repo
https://gitlab.com/example/example-repo/-/tree/main/path/to/dir           → gitlab, subdir path/to/dir
https://github.com/example/example-repo                                   → github, whole repo
```

Issues with **no link** fall back to a per-team default repo, overridable via the `GENE_REPO_URL` env var or 
the `GENE_REPO_MAP` env var (a JSON object of `team key → repo URL`).
All resolution logic lives in `src/repos.ts`.

## Multi-repo model

- **geneai** (this repo) — the orchestrator. All pipeline code is in `src/`.

- **target repos** — cloned under `repos/<repoPath>/` (gitignored) and kept.
  A repo is cloned **on demand** the first time an issue targets it; `npm run clone`
  pre-clones the team defaults so the common path is warm. Per-issue worktrees are
  created at `repos/.worktrees/<repoPath>/<ISSUE-ID>`, branched off the base. The
  branch name follows `GENE_BRANCH_TEMPLATE` (default `{prefix}/{identifier}-{slug}`;
  see `.env.example`).
  Runtime locks live in `.gene/` (gitignored); the persistent state store is a local
  **Postgres** with its data under `data/pg/` (gitignored), started by `npm run pg`.

## Setup

Prerequisites: Node ≥ 26.3.0 (via [Volta](https://volta.sh) — pinned in
`package.json`; the console daemon runs on Node 24+ too, only the
[TUI dashboard](#tui-dashboard) needs 26.3.0), **PostgreSQL** (`brew install postgresql@16` — the daemon's state store; `npm run pg`
init-and-runs it locally on port 5433), the `claude`, `git`, and `glab` and/or `gh`
CLIs on `PATH`, and — for the **Linear** backend — the `linear` CLI. The **Trello** backend needs no extra CLI: it uses the
bundled `trello/` wrapper, which only wants `TRELLO_API_KEY` + `TRELLO_TOKEN`.

> Prefer isolation? The whole toolchain is packaged as a microVM — see
> [`sandbox/`](sandbox/README.md) to run `claude -p` agents in a throwaway VM
> (microsandbox) instead of installing the CLIs on your host.

```bash
# 1. Authenticate the CLIs (one-time, interactive — run with a leading `!` here)
glab auth login --hostname gitlab.example.com      # accept "use glab as a git credential helper"
gh auth login                                      # only if any issue targets a GitHub repo
linear login                                       # Linear backend: if not already logged in
claude  /login                                     # OAuth / Max session
# Trello backend (GENE_TRACKER=trello): no login — mint TRELLO_API_KEY + TRELLO_TOKEN at
#   https://trello.com/power-ups/admin and put them in .env.development (see trello/README.md)

# 2. Configure
cp .env.example .env.development                   # then edit .env.development
npm install                                        # dev-only deps (typescript, @types/node)

# 3. (Optional) pre-clone the team default repo(s)
npm run clone
```

`.env.development` is gitignored — put your secrets there. Everything has a safe
default; see `.env.example` for the full list. **`GENE_DRY_RUN` defaults to
`true`** (log-only, no writes, no spawns).

## Usage

```bash
npm start               # Postgres + the daemon (poll loop), together via concurrently
npm run start:ui        # ...same, but with the OpenTUI dashboard (see "TUI dashboard" below)
npm run once            # Postgres + a single scan, then exit  (great with GENE_DRY_RUN=true)
npm run pg              # just the local Postgres (port 5433) — leave up for the commands below
npm run ui              # the OpenTUI dashboard against an already-running pg (needs Node ≥26.3.0)
npm run clone           # pre-clone the team default repo(s)
npm run reset -- CLOUD-1094            # reset one issue back to Todo   (needs Postgres up)
npm run reset -- CLOUD-1094 --close-mr # ...and close its open MR/PR
npm run log -- linear:CLOUD-1094       # show one issue's activity log (needs Postgres up)
npm run typecheck       # tsc --noEmit
```

Go live by setting `GENE_DRY_RUN=false` in `.env.development`. A dry-run scan prints
exactly what it *would* do (decision, resolved target repo + forge, branch, prompt
size) without touching the tracker or the forge.

## TUI dashboard

An optional Symphony-style terminal UI over the same in-process daemon: a status
header (agents N/MAX, uptime, current stage, next-refresh countdown, tokens, scan
counts) that stays pinned at the top across both views, a live table of
running/recent tickets (one-liner + stage each, re-sortable), a per-ticket view
(the last few actions pinned above a scrollable live log), and inline agent
cancellation / reset. The poll loop runs in the
*same* process as the renderer — so the data is live and cancel is immediate, no
separate observer or IPC.

```bash
npm run start:ui                      # Postgres (background) + dashboard (foreground), one command
npm run start:ui -- linear:CLOUD-1094 # …focused on one issue (focus + dry-run flags pass through)
npm run ui                            # dashboard only, against an already-running pg (e.g. npm run pg elsewhere)
```

`start:ui` runs Postgres in the background and the dashboard in the foreground
(see `ui.sh`) — a full-screen TUI must own the terminal, so it
*can't* be hosted under a stdio multiplexer like `concurrently` (which would
leave the renderer with no TTY: a tiny window and a dead keyboard). It reuses a
Postgres that's already listening, and stops only the one it started.

Requires **Node ≥ 26.3.0** — OpenTUI's native renderer loads over FFI, which the
`ui` script enables (`--experimental-ffi`). On an older Node it prints install
guidance and exits cleanly; the console daemon (`npm run gene` / `npm start`) is
unaffected and still runs on Node 24+.

Keys: `↑↓` / `j` `k` navigate (selection is hidden until you move) · `enter` / `→`
open the selected ticket's log · `s` cycle the table sort (status → age → id; the
selected ticket stays selected) · `c` cancel the selected running agent (press again
within 2s to confirm) · `r` reload history from Postgres · `esc` back out of a
ticket (or clear the selection on the table) · `q` / `Ctrl+C` quit — restores the
terminal, then shuts the daemon down gracefully. Inside a ticket, the last few
actions stay pinned at the top while `↑↓` / `PgUp` / `PgDn` / `Home` / `End` scroll
the live log below them (a finished ticket shows its full history there), and `R`
resets the ticket (worktree / branch / lock + back to Todo — same as `npm run
reset`; press again within 2s to confirm).

## Runtime: native TypeScript, minimal deps

Node runs the `.ts` files directly (type-stripping — no build step, available since
Node 24), so:

- relative imports **must** include the `.ts` extension (`import … from "./x.ts"`);
- no TypeScript-only runtime constructs (enums, namespaces, constructor parameter
  properties) — strip-only mode rejects them;
- env is loaded by `node --env-file-if-exists=.env.development` (in the npm scripts);
- the only runtime dependency is **`pg`** — the daemon's persistent state lives in a
  local **Postgres** (`db.ts`), brought up by `npm run pg`; env parsing stays
  hand-rolled in `config.ts`.

## File map

```
src/
  index.ts        daemon: scan → decide → dispatch (--once supported)
  config.ts       env + constants (hand-rolled, no zod)
  db.ts           Postgres state store: review cursor + issue activity log
  logger.ts       timestamped server logger
  monitor.ts      in-process event bus + agent/daemon state for the TUI (no OpenTUI)
  decide.ts       pure (issue, comments) → Action
  review.ts       In-Review watchdog + draft pickup: find the open MR/PR, decide re-dispatch
  directives.ts   `!gene approve|redo|stop|retry` parser
  prompt.ts       builds the agent's prompt (the full contract it runs under)
  invoke.ts       worktree management + spawns `claude -p`, renders stream-json
  lock.ts         per-issue file lock (keyed by ISSUE-ID), stale-PID reclamation
  attachments.ts  best-effort staging of tracker image attachments into the worktree
  reset.ts        reset one issue (worktree/branch/lock + back to Todo)
  log.ts          show one issue's activity log (npm run log -- <sys>:<id>)
  repos.ts        per-issue link → RepoTarget (forge/host/repoPath/subdir + defaults)
  clone.ts        pre-clone the team default repo(s) (npm run clone)
  tracker/
    index.ts      Tracker interface + neutral Issue/Comment/Attachment + selectTracker
    linear.ts     Linear impl (read via `linear api`, write via `linear issue …`)
    trello.ts     Trello impl (bundled trello/ wrapper; agent writes via the trello CLI)
  forge/
    index.ts      Forge interface + selectForge(name)
    gitlab.ts     glab implementation
    github.ts     gh implementation
  ui/             OpenTUI dashboard (loaded only under --ui; needs Node ≥26.3.0)
    app.ts        startUi: mounts the persistent header + bodies, wires keys, runs the loop
    header.ts     the pinned status block (shared by both views)
    dashboard.ts  agents table (re-sortable) + log tail (the main screen)
    detail.ts     per-ticket view: pinned last-5 actions + scrollable live log (history fallback) + reset
    theme.ts      color palette, status colors/glyphs, spinner frames
    format.ts     tiny formatters (duration, tokens, truncation, progress bar)
ui.sh             start:ui — background Postgres + foreground dashboard (real TTY)
```

## Adding a forge

Implement the `Forge` interface (`src/forge/index.ts`) in a new file and register it
in `selectForge()`. The interface covers cloning, default-branch detection, the
agent's allowlist additions (`allowedTools()`), the MR/PR instructions injected into
the prompt (`promptSnippet()`), closing a change request (used by `npm run reset
--close-mr`), and reading an open change request's CI + review comments — both by
source branch (`getReviewStatus()`) and by number (`getReviewByIid()`, used to pick
up an attached MR/PR on a human-named branch). To route issues to it, teach
`parseRepoUrl()` in `src/repos.ts` how to recognise its host so a link maps to the new
`ForgeName`.

## Trackers (Linear / Trello)

Which tracker Gene drives is set by **`GENE_TRACKER`** (`linear` | `trello`, default
`linear`). Unlike the per-issue forge, the tracker is a **process-wide singleton**.
Both implement one `Tracker` interface (`src/tracker/index.ts`) over neutral `Issue` /
`Comment` / `Attachment` types, so the rest of `src/` is tracker-agnostic.

|  | Linear | Trello |
|---|---|---|
| issue | an issue | a **card** |
| state | workflow state name | the card's **list** name |
| label | `Gene` label | `Gene` label |
| identifier | `CLOUD-1094` | the card's `shortLink` |
| branch | Linear's auto-link branch | synthesized `gene/<shortLink>` |
| read access | `linear` CLI (`linear api`) | bundled `trello/` wrapper (REST) |
| agent write-back | `linear issue …` | bundled `trello` CLI (`node trello/cli.ts`) |
| auth | `LINEAR_API_KEY` / `linear login` | `TRELLO_API_KEY` **+** `TRELLO_TOKEN` |

Tracker-specific config is **namespaced by the active tracker** (`LINEAR_*` /
`TRELLO_*`); only the selected block is read, so the internal names stay neutral and
every consumer is unchanged. Trello also needs **`TRELLO_BOARD`** (the board whose
cards it watches) and accepts an optional **`TRELLO_LIST_MAP`** (JSON `state-name →
list-id`) for when a board's list names differ from the state names. See
`.env.example` for the full list, and `trello/README.md` for minting the key + token.

Two honest differences from Linear: Trello has **no MR/PR ↔ card auto-link** (the
agent instead links the change request in the card's description/comments, which is
what `review.ts` discovery already scans), and the assignee filter matches a **Trello
username**, not an email (`me` / `any` work identically).

**Adding a tracker.** Implement the `Tracker` interface (`src/tracker/index.ts`) in a
new file and register it in `selectTracker()`. The interface covers listing
label-filtered issues, reading comments + attachments (and downloading them), posting
a comment and moving state (both honoring `GENE_DRY_RUN`), the assignee filter, the
agent's allowlist additions (`allowedTools()`), and the write-back instructions
injected into the prompt (`writeBackSnippet()` — how the agent comments and moves
state). Add its config keys to `config.ts` (namespaced by the tracker's prefix) and
document them in `.env.example`.

## Design notes

- Lifecycle is driven by the tracker's **states** (Linear workflow state / Trello
  list); the `Gene` label is an ownership tag and is never removed.
- Agent identity is established by a **comment marker** (both trackers post as a
  single user, so author id can't distinguish Gene from a human).
- **Ignore patterns** drop comments that shouldn't trigger Gene (other bots'
  `/review`, status chatter) — substring or `/regex/` per source, plus built-ins
  (`ignore.ts`).
- **Pluggable tracker**: Linear or Trello behind one `Tracker` interface, chosen by
  `GENE_TRACKER` — a singleton, mirroring the per-issue forge layer.
- **Per-issue targeting**: the forge and repo come from a link in the issue, so a
  single team spans multiple repos and both forges without per-repo config.
- **Draft change requests** (optional, `GENE_DRAFT_CHANGE_REQUEST`): Gene opens
  every MR/PR as a draft and never marks it ready — a human reviews, marks it ready,
  and merges. Off by default; works on both GitLab and GitHub.
- **Two-repo** model (orchestrator vs cloned targets); worktrees branch off the clone.
- Native Node 24 TS — **no build**, `.ts` imports, `--env-file`; **one runtime dep**
  (`pg`, talking to a local Postgres for state).
- Description **section enforcement is off** by default (real tickets are free-form).
