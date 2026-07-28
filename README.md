# 🧬 Gene AI

**Gene AI is an autonomous AI harness powered by Claude Code — from a ticket to a mergeable pull request, completely automated.**

Gene AI is a console app you run on your machine. It watches your issue tracker — **Linear** or **Trello** — for tickets labelled **`Gene`** and assigned to you, and for each one dispatches a [Claude Code](https://github.com/anthropics/claude-code) agent in a
dedicated git worktree to do the work and open a pull/merge request. It then watches
that change request through review and CI — replying to comments, fixing CI failures — until it's ready to merge. **Gene opens change requests but never merges them itself**, so you stay in control where it matters.

It's the personal, unattended *harness* around `claude`, not a replacement for it: watching the tracker, the ticket lifecycle, per-issue multi-repo/forge routing, and the review/CI re-dispatch loop are what Gene adds. If you already drive Claude
Code by hand, Gene is what runs it for you — from a ticket — while you do something more meaningful.

> **Status:** open source (**Apache-2.0**) and under active development. The prebuilt binary is **macOS arm64**; on other platforms, build manually from the source code.

<img width="1505" height="898" alt="Screenshot 2026-06-21 at 21 01 27" src="https://github.com/user-attachments/assets/86c5d374-5889-464b-b8d6-f715cc9463e0" />


## Workflow

```
    Linear               Worktree              GitHub
    Trello               (sandbox)             GitLab
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

Gene AI watches your issue tracker — **Linear** or **Trello** — for **Todo** issues (or Trello cards) labelled
**`Gene`**, and for each one dispatches a `claude` agent — running with a dedicated git
worktree — to do the work and open a change request. Each issue chooses its own target
repo (and the assigned forge) from a link in the issue, so one tracker can drive
**GitLab** and **GitHub** repos side by side.

## Writing tickets

Gene only acts on an issue when **all** of these hold — so an issue needs:

- **the `Gene` label** — the ownership tag the daemon filters on (never removed by Gene);
- **an assignee of you** — the tracker user Gene is authenticated as (`LINEAR_ASSIGNEE` /
  `TRELLO_ASSIGNEE`, default `me`; set `any` to drop the filter, or a specific user to
  work on their behalf);
- **a target repo** — a GitLab/GitHub link in the description (the **first** link wins;
  comments are a fallback), or mapped via `GENE_REPO_MAP` / `GENE_REPO_URL`
  (see [Repo targeting](#repo-targeting-per-issue)); it also falls back to the local repo
  URL when Gene's working directory is itself a git repo.
- **state `Todo`** — the trigger for new agent task. The other states are reactions to
  comments / CI, see the [lifecycle table](#lifecycle-issue-states).

Write the **description** for an engineer who would pick it up without any prior knowledge — the agent sees only the
issue, its comments, and the repo. Say **what** and **why**, not how, and attach screenshots / logs to the issue (image attachments and markdown files are added as temporary files into 
the worktree the agent works in).

Recommended: set `GENE_REQUIRE_SECTIONS` to require specific headings in the issue description so 
Gene will know what to do. If set, and missing, Gene will reply asking for them and moves
the issue to **Blocked** until you fill them in. The recommended sections are:

- **`## Problem`** — the bug or desired change, with enough context to reproduce or locate it.
- **`## Acceptance criteria`** — what "done" looks like, concretely, including *"unit tests/e2e tests etc added/updated for this issue"*.

## How it works

**Gene** checks the issue tracker, decides, posts a start comment, moves the
issue to **In Progress**, clones the repo into a worktree, and downloads any attachments. 
The **spawned Claude Code agent** does everything else — code changes, the merge/pull request, 
and the tracker write-back (comments + the terminal state move).

## Lifecycle (issue states)

The lifecycle is driven by the issue **status** in Linear, or the **list** the card is on in Trello.
Each scan, for every eligible issue, Gene decides what to do next:

| Tracker state | What the daemon sees | What Gene does |
|---|---|---|
| **Todo** | a change request is already attached | **continues** that change request on its own branch — skips planning |
| **Todo** | no change request yet | starts **from scratch**: plan → code → open the MR/PR → **In Review** |
| **In Progress** | a new human comment | hands it to the work in flight as **feedback** |
| **Blocked** | a new human reply | **resumes** — Gene had asked a question or proposed a plan that a human needs to confirm |
| **In Review** | a new review comment on the change request | re-dispatches Claude Code to **address** it — acts **even while CI is still running** |
| **In Review** | the CI/CD for a change request **failed** | re-dispatches Claude Code to **address** the failure |
| **In Review** | nothing new (quiet; CI green or still running) | **no-op** — waits for the next signal |
| **In Review** | the change request has been **merged** | moves issue to → **Done** (when `LINEAR_DONE_STATE` is set) |

Eligibility (label `Gene`, **assigned to you**, a target repo) and what to put in the
description are covered in **[Writing tickets](#writing-tickets)**.

The `Gene` label is an **ownership tag** and is never removed by the pipeline.
Each scan watches `Gene` issues in **{Todo, In Progress, Blocked, In Review}** and
handles ongoing work — active conversations (In Progress / Blocked) and open change
requests (In Review) — *before* picking up new Todo work.

**Assignee filter** Gene only works issues **assigned to you** — the tracker user it
is authenticated as. Issues with the `Gene` label assigned to someone else (or
unassigned) are skipped and logged. Set the assignee filter (`LINEAR_ASSIGNEE` /
`TRELLO_ASSIGNEE`) to `any` to drop it, or to a specific user — Linear by email, Trello
by username — to work on their behalf (default: `me`).

**Agent vs human comments** Gene posts as your own tracker user (both backends do),
so author identity can't tell them apart. Every comment Gene writes carries a marker
(`GENE_AGENT_MARKER`, default `#gene-ai`); `decide.ts` treats marker-bearing
comments as Gene's, and a human comment newer than Gene's last one is the trigger
to resume / handle feedback.

**Ignored comments** Some comments shouldn't count as a trigger —
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

**In-Review handling** Once a change request is open, the daemon
polls the forge for two signals before it touches new Todo work: a **failing
pipeline / Actions run**, and **new review comments** on the MR/PR (the same
marker tells Gene's own replies from a human's). On either, it re-dispatches the
agent to push a fix and reply. A **new human comment is acted on immediately —
even while CI is still running**, so a reviewer never has to wait for a pipeline
to finish to be heard. Running CI only defers the cases where it logically must:
a still-running pipeline can't be a *failure* yet, and a draft pickup with nothing
new won't pile a fresh run onto mid-flight CI. With no new signal at all, the scan
is a no-op and the daemon moves on. A per-issue cursor (the handled head SHA +
newest comment, stored in the state store via `db.ts`) ensures each signal triggers
exactly one dispatch, not one per poll.

**Auto-progress to Done on merge** Set `<TP>_DONE_STATE`
(e.g. `TRELLO_DONE_STATE=Done` / `LINEAR_DONE_STATE=Done`) and the daemon moves an
In-Review issue to that state — with a comment — as soon as its change request
merges, instead of waiting for a human to drag it across. Left unset, merge→Done
stays a manual step (the default).

**Stalled Claude Code calls moved to Blocked** `claude -p` exits `0` even if its connection
to the model API drops mid-stream or it dies before emitting a final result. The
daemon detects both (a transient-transport signature in the stream, or a missing
success result), retries within the agent's retry budget, and — if it still didn't
finish — posts a "I stopped before finishing — reply to resume" comment and moves
the issue to **Blocked** rather than letting it stall silently In Progress. The
worktree is preserved, so a reply resumes from where it left off.

**Interrupted runs recover on restart** If the daemon itself
is killed while an agent is mid-run — a hard quit, a crash, a reboot — that run
never records an outcome; its activity log just ends at `agent-start`. On the next
startup the daemon **reconciles** these: it writes a closing `agent-interrupted`
event for each (so the run stops haunting the dashboard as a stale in-flight row,
shown there as the `interrupted` status), and — because the issue is still **In
Progress** — the very next scan re-picks it up and continues from the preserved
worktree. The per-issue file lock is self-healing (it records the owning PID, and a
lock held by a now-dead process is reclaimed on the next dispatch), so a hard kill
never wedges an issue.

**Low-latency reactivity (optional Trello webhook)** By default the daemon reacts
within `GENE_POLL_INTERVAL_MS`. On Trello you can drop that to seconds: set
`GENE_WEBHOOK_URL` (a public tunnel pointing at the local listener on
`GENE_WEBHOOK_PORT`, default `8473`) plus `TRELLO_API_SECRET`, register the board
webhook with `npm run webhook`, and board activity wakes the poll loop immediately.
It's a per-tracker capability (`Tracker.startWatch`); without it the daemon just
polls — correctness never depends on the webhook.

**Draft pickup** If a Todo issue **already has an open change
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

**Activity log** Alongside the review cursor, the daemon records a
per-issue **activity log** in the state store, keyed by `(tracker, issue id)`:
each dispatch, the agent's start / finish (with its own final summary), review
re-dispatches, draft pickups, and resets (dry-run entries are flagged). Inspect one
issue's history with `npm run log -- <system>:<id>` (e.g. `linear:CLOUD-1094`; a bare
id defaults the system to `GENE_TRACKER`). With the **opt-in Postgres backend** the
store is multi-connection, so a one-shot command (`log` / `reset`) reads it fine
while the daemon runs — both point at the same server. The **default embedded store**
is single-process: stop the daemon before running `log` / `reset`, or point both at a
shared Postgres (`DATABASE_URL` / `PG*`). See [State store](#state-store).

## Safety and control

Gene runs unattended and acts with your credentials, so the guardrails are deliberate:

- **It never merges.** Gene opens and updates change requests, and can mark a draft
  ready for review, but it never merges a PR/MR or pushes to your default branch —
  merging is always a human action.
- **Draft mode is a hard human gate.** With `GENE_DRAFT_CHANGE_REQUEST=true` every
  change request opens as a **draft** and Gene never marks it ready; a human reviews and
  promotes it. This is enforced, not just requested: when a run finishes, Gene checks the
  change request and pushes it back to draft if the agent left it ready for review.
- **Dry run.** `GENE_DRY_RUN=true` makes a full pass with **no tracker/forge writes and
  no agent spawns** — it just logs what it *would* do. The best way to try it on a real
  board.
- **It only touches tickets you opt in.** A ticket is acted on only when it carries the
  **`Gene`** label **and** is assigned to you (`*_ASSIGNEE`); everything else is skipped.
- **Secrets stay local.** Config splits into a committed `gene.config` and a gitignored
  `.gene.config` (keys, tokens), with real env always winning. Your `ANTHROPIC_API_KEY`
  is handed to the agent **only** when you opt into API billing — otherwise it's stripped
  from the agent's environment.
- **Optional sandbox.** Set `GENE_SANDBOX=true` to run each `claude -p` agent inside a
  throwaway microVM instead of on your host (see [`sandbox/`](sandbox/README.md)).
- **Self-hosted, no phone-home.** Gene runs on your machine; its only outbound calls are
  to your tracker, your forge, and the Claude API (via `claude`).
- **Stuck runs fail safe.** A stalled or interrupted agent is retried, then parked in
  **Blocked** with a comment rather than left hanging In Progress — and the worktree is
  preserved so a reply resumes it.

## Repo targeting (per issue)

An issue declares its target repo simply by including a **GitLab or GitHub link**
in its description — the **first** such link wins (comments are checked as a
fallback). From the link Gene derives:

- **the change request forge** — from the host: `gitlab.*` → `glab`, `github.com` → `gh`;
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
the `GENE_REPO_MAP` env var (a JSON object of `team key → repo URL`). If you run Gene from inside a git repo, 
that local repo becomes the default.

## Repository model

- **target repos** — cloned under `.gene/repos/<repoPath>/` (gitignored; can be changed by `GENE_REPOS_DIR`).
  A repo is cloned **on demand** the first time an issue targets it; per-issue worktrees are
  created at `.gene/repos/.worktrees/<repoPath>/<ISSUE-ID>`, branched off the base. The
  branch name follows `GENE_BRANCH_TEMPLATE` (default `{prefix}/{identifier}-{slug}`;
  see `.env.example`).
  Runtime locks live in `.gene/` (gitignored); the persistent **state store** needs
  no setup — embedded PGlite under `~/.config/gene/` by default, or an external
  Postgres when `DATABASE_URL` / `PG*` is set (see [State store](#state-store)).

## State store

Gene keeps its persistent state — the per-issue **review cursor** and **activity
log** (`db.ts`) — in a small PostgreSQL store, with two backends picked automatically:

- **Embedded PGlite (default)** — Postgres compiled to WASM, running in-process. No
  server, no setup: data lives under `~/.config/gene/pgdata` (override with
  `GENE_DB_DIR`; honours `XDG_CONFIG_HOME`). This is what makes Gene
  **self-contained** — `npm start` just works. It is **single-process**: one Gene
  owns the data dir behind a self-healing PID lock, so a one-shot `log` / `reset`
  can't run *while* the daemon is up — stop it first, or use Postgres.
- **Postgres server (opt-in)** — set `DATABASE_URL` (or any `PG*`: `PGHOST`,
  `PGDATABASE`, …) and Gene talks to that instead. Multi-connection, so `log` /
  `reset` work alongside a running daemon. `npm run pg` brings up a throwaway local
  cluster under `data/pg/` (gitignored) on port **5434** if you want one locally.

The schema is identical either way; switching backends starts a fresh store (state
is not migrated between them).

## Requirements

- **Claude Code** — Gene shells out to `claude -p`, so you need either a Claude
  subscription (`claude /login`) or an `ANTHROPIC_API_KEY` with API billing
  (`GENE_CLAUDE_API_BILLING=true`). **This is where the cost is:** Gene itself is free
  and open source, but every dispatch — the initial work, plus each re-dispatch for a CI
  failure or review comment — is a real `claude` run. Token usage scales with ticket
  complexity and `GENE_MAX_CONCURRENT`; start with `GENE_DRY_RUN=true` and low
  concurrency to get a feel for it.
- **An issue tracker** — a Linear or Trello account (`GENE_TRACKER`).
- **A change request forge and its CLI** — `gh` (GitHub) and/or `glab` (GitLab), authenticated; plus `git`, and the `linear` CLI for the Linear backend.
- **OS** — the prebuilt binary is **macOS arm64** only. On Linux/Windows, run from
  source with Node 26 (`npm start`); everything but the single-file binary works the same.

## Installation

### Standalone binary (macOS arm64)

Install — or upgrade — to the latest release with one command. It drops a `gene` binary
on your `PATH` (`/usr/local/bin` if writable, else `~/.local/bin`):

```bash
curl -fsSL https://raw.githubusercontent.com/huksley/gene/main/install.sh | bash
```

Pass options after `-s --` to choose where it lands or pin a release:

```bash
# install into a specific directory
curl -fsSL https://raw.githubusercontent.com/huksley/gene/main/install.sh | bash -s -- --dir ~/.local/bin
# or a specific release tag
curl -fsSL https://raw.githubusercontent.com/huksley/gene/main/install.sh | bash -s -- --version v1.2.3
```

Once installed, **update in place** from the running binary:

```bash
gene --update            # download + install the latest release (atomic, with rollback)
gene --update --force    # reinstall even if already on the latest
gene --version
gene --help
```

The binary bundles the embedded state store, so it needs no other dependencies to run —
but Gene still shells out to the runtime CLIs (`claude`, `git`, `gh`/`glab`, and
`linear` for the Linear backend). Install whichever you need from the
[Dependencies](#dependencies) table below.

## Dependencies

Once Gene is installed, authenticate the CLIs and configure your environment. The **Trello** backend needs
no CLI login — it uses `TRELLO_API_KEY` + `TRELLO_TOKEN` via the optional @huksley/trello-cli.

> Prefer isolation? The whole toolchain is packaged as a microVM — see
> [`sandbox/`](sandbox/README.md) to run `claude -p` agents in a throwaway VM
> (microsandbox) instead of installing the CLIs on your host.

```bash
# 1. Authenticate the CLIs (one-time, interactive — run with a leading `!` here)
glab auth login [--hostname gitlab.example.com]    # accept "use glab as a git credential helper"
gh auth login                                      # only if any issue targets a GitHub repo
linear login                                       # Linear backend: if not already logged in
claude /login                                      # OAuth / Subscription session or ANTHROPIC_API_KEY for API usage 

# Trello backend (GENE_TRACKER=trello): no login — mint TRELLO_API_KEY + TRELLO_TOKEN at https://trello.com/power-ups/admin and put them in .env.development (see trello/README.md)
# install Trello CLI
npm install -g @huksley/trello-cli

# 2. Configure (see .env.example for all supported params)

# Repo config - safe to add to the git
cat >gene.config <<END
# Use Linear
GENE_TRACKER=linear
LINEAR_TRIGGER_STATE=Todo
LINEAR_ACTIVE_STATE=In Progress
LINEAR_BLOCKED_STATE=Blocked
LINEAR_REVIEW_STATE=In Review
LINEAR_DONE_STATE=Done
GENE_REQUIRE_SECTIONS=## Problem,## Acceptance criteria
# How often recheck the issue tracker
GENE_POLL_INTERVAL_MS=30000
# How many tasks to run at the same time
GENE_MAX_CONCURRENT=4
LINEAR_IGNORE_COMMENTS=!review,/review
GITHUB_IGNORE_COMMENTS=/review,/linear
GENE_DRAFT_CHANGE_REQUEST=true
# Additional allowed tools for Claude Code
GENE_ALLOWED_TOOLS="Bash(ntn *)"
# Optional: run the agent in a sandbox
GENE_SANDBOX=false
END

# Secrets (never commit to the repo, add to .gitignore)
cat >.gene.config<<END
LINEAR_API_KEY=yourapikey
END

# Opt-in to the sandbox (experimental, optional)
# install microsandbox from https://microsandbox.dev/
npm install -g microsandbox

# 3. Run Gene
gene
```

## Trackers (Linear / Trello)

Which issue tracker Gene uses is set by **`GENE_TRACKER`** (`linear` | `trello`, default
`linear`), which is used for the work queue.

|  | Linear | Trello |
|---|---|---|
| issue | an issue | a **card** |
| state | workflow state name | the card's **list** name |
| label | `Gene` label | `Gene` label |
| identifier | `TASK-1094` | the card's `shortLink` |
| branch | Linear's auto-link branch, overridable | synthesized `gene/<shortLink>`, overridable |
| read access | `linear` CLI (`linear api`) | provided trello-cli |
| agent write-back | `linear issue …` | provided trello-cli |
| auth | `LINEAR_API_KEY` / `linear login` | `TRELLO_API_KEY` **+** `TRELLO_TOKEN` |

Tracker-specific config is **namespaced by the active tracker** (`LINEAR_*` /
`TRELLO_*`); only the selected block is read, so the internal names stay neutral and
every consumer is unchanged. Trello also needs **`TRELLO_BOARD`** (the board whose
cards it watches) and accepts an optional **`TRELLO_LIST_MAP`** (JSON `state-name →
list-id`) for when a board's list names differ from the state names. See
`.env.example` for the full list, and `trello/README.md` for minting the key + token.

Two honest differences from Linear: Trello has **no MR/PR ↔ card auto-link**, so the
agent links the change request in the card's description/comments instead; and the
assignee filter matches a **Trello username**, not an email (`me` / `any` work
identically).

## FAQ

**Does Gene merge code by itself?**
No. It opens and updates pull/merge requests and can mark a draft ready for review, but
a human always does the merge — and with `GENE_DRAFT_CHANGE_REQUEST=true` it won't even
mark them ready. See [Safety and control](#safety-and-control).

**What does it cost to run?**
Gene is free and open source (Apache-2.0). The cost is whatever Claude Code costs you: it
runs `claude -p` under your subscription or `ANTHROPIC_API_KEY`. Each dispatch is a real
run, and re-dispatches (CI failures, review replies) add up, so token usage scales with
ticket complexity and `GENE_MAX_CONCURRENT`.

**Are my code or secrets sent anywhere? Does it phone home?**
No phone-home — Gene is self-hosted. Your code reaches Anthropic exactly as it would if
you ran Claude Code by hand. Secrets stay in your gitignored `.gene.config`/environment,
and your API key is handed to the agent only when you turn on API billing.

**Is it macOS only?**
The prebuilt binary is macOS arm64. On Linux/Windows you run from source with Node 26 —
same behaviour, just no single-file binary.

**Why not just use Claude Code (or aider) directly?**
Gene is the harness *around* `claude`, not a replacement: it polls your tracker, drives
the ticket lifecycle, routes each issue to its own repo/forge, re-dispatches on CI
failures and review comments, and recovers from crashes — so a ticket becomes a PR while
you're doing something else.

**What if it gets something wrong or gets stuck?**
You review every PR before it merges, and draft mode adds a gate. A stalled or
interrupted run is retried and then parked in **Blocked** with a comment, not left
hanging — and the worktree is kept so your reply resumes it. Run with `GENE_DRY_RUN=true`
first to watch its decisions with zero writes.

**Can I run it headless on a server?**
Yes — `gene --headless` runs the daemon without the TUI dashboard, logging to stdout
(`gene --once` does a single scan and exits). Point it at an external Postgres
(`DATABASE_URL`) if you want to inspect state while it runs.

**Which trackers and forges are supported?**
Trackers: **Linear** and **Trello**. Forges: **GitHub** and **GitLab**, chosen per issue
from the repo link. Jira, GitHub Issues, and Bitbucket aren't supported yet.

**Does it work on monorepos?**
Yes — a `…/tree/<branch>/<path>` deep link in the ticket scopes the agent to that
subdirectory and base branch. See [Repo targeting](#repo-targeting-per-issue).

**How do I try it safely first?**
Set `GENE_DRY_RUN=true` and a low `GENE_MAX_CONCURRENT`, label one throwaway ticket, and
watch the logs — Gene reports what it *would* do without writing to your tracker or forge
or spawning agents.
