# 🧬 Gene AI

**Gene AI is an autonomous AI harness powered by Claude Code — from a ticket to a mergeable pull request, completely automated.**

<img width="1505" height="898" alt="Screenshot 2026-06-21 at 21 01 27" src="https://github.com/user-attachments/assets/86c5d374-5889-464b-b8d6-f715cc9463e0" />


## Workflow

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

## Writing tickets

Gene only acts on an issue when **all** of these hold — so a ticket needs:

- **the `Gene` label** — the ownership tag the daemon filters on (never removed by the pipeline);
- **an assignee of you** — the tracker user Gene is authenticated as (`LINEAR_ASSIGNEE` /
  `TRELLO_ASSIGNEE`, default `me`; set `any` to drop the filter, or a specific user to
  work on their behalf);
- **a target repo** — a GitLab/GitHub link in the description (the **first** link wins;
  comments are a fallback), or a team mapped via `GENE_REPO_MAP` / `GENE_REPO_URL`
  (see [Repo targeting](#repo-targeting-per-issue));
- **state `Todo`** — the trigger for new work. The other states are reactions to
  comments / CI, see the [lifecycle table](#lifecycle-tracker-workflow-states).

Write the **description** for an engineer picking it up cold — the agent sees only the
issue, its comments, and the repo. Say **what** and **why**, not how, and paste
screenshots / logs (image attachments are staged into the worktree).

When `GENE_REQUIRE_SECTIONS` is set, the description **must** carry those headings with
a non-empty body, or Gene replies asking for them and moves the issue to **Blocked**
until you fill them in. The recommended shape (and what this deployment requires —
`## Problem,## Acceptance criteria`):

- **`## Problem`** — the symptom or desired change, with enough context to reproduce or locate it.
- **`## Acceptance criteria`** — what "done" looks like, concretely, including
  *"tests added/updated for this scenario"*.

## How it works

The **orchestrator** checks issues, decides, posts a start comment, moves the
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

Each scan, for every eligible issue, the **(state, situation)** pair decides what Gene does:

| Tracker state | What the daemon sees | What Gene does |
|---|---|---|
| **Todo** | an MR/PR is already attached | **continues** that change request on its own branch — skips planning |
| **Todo** | no change request yet | starts **from scratch**: plan → code → open the MR/PR → **In Review** |
| **In Progress** | a new human comment | hands it to the work in flight as **feedback** |
| **Blocked** | a new human reply | **resumes** — Gene had asked a question or proposed a plan |
| **In Review** | a new review comment on the MR/PR | re-dispatches to **address** it — acts **even while CI is still running** |
| **In Review** | the CI pipeline **failed** | re-dispatches to **address** the failure |
| **In Review** | nothing new (quiet; CI green or still running) | **no-op** — waits for the next signal |
| **In Review** | the MR/PR **merged** | → **Done** (when `<TP>_DONE_STATE` is set; otherwise a human drags it) |

Eligibility (label `Gene`, **assigned to you**, a target repo) and what to put in the
description are covered in **[Writing tickets](#writing-tickets)**.

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
newest comment, stored in the state store via `db.ts`) ensures each signal triggers
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
id defaults the system to `GENE_TRACKER`). With the **opt-in Postgres backend** the
store is multi-connection, so a one-shot command (`log` / `reset`) reads it fine
while the daemon runs — both point at the same server. The **default embedded store**
is single-process: stop the daemon before running `log` / `reset`, or point both at a
shared Postgres (`DATABASE_URL` / `PG*`). See [State store](#state-store).

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

- **target repos** — cloned under `.gene/repos/<repoPath>/` (gitignored; set by
  `GENE_REPOS_DIR`) and kept.
  A repo is cloned **on demand** the first time an issue targets it; `npm run clone`
  pre-clones the team defaults so the common path is warm. Per-issue worktrees are
  created at `.gene/repos/.worktrees/<repoPath>/<ISSUE-ID>`, branched off the base. The
  branch name follows `GENE_BRANCH_TEMPLATE` (default `{prefix}/{identifier}-{slug}`;
  see `.env.example`).
  Runtime locks live in `.gene/` (gitignored); the persistent **state store** needs
  no setup — embedded PGlite under `~/.config/gene/` by default, or an external
  Postgres when `DATABASE_URL` / `PG*` is set (see [State store](#state-store)).

## State store

Gene keeps its persistent state — the per-issue **review cursor** and **activity
log** (`db.ts`) — in a small SQL store, with two backends picked automatically:

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

## Installation

Two ways to run Gene: the **prebuilt standalone binary** (macOS arm64 — one
self-contained `gene` executable, no Node or `npm install`), or **from a source
checkout** (any platform; how you develop on it). Either way Gene shells out to a few
CLIs (`claude`, `git`, your forge CLI, …) and keeps its state in an **embedded store
that needs no setup** ([State store](#state-store) — Postgres is opt-in).

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

The binary bundles the embedded state store, so it needs no Node and no `npm install` —
but Gene still shells out to the runtime CLIs (`claude`, `git`, `gh`/`glab`, and
`linear` for the Linear backend). Install whichever you need from the
[Dependencies](#dependencies) table below.

> Releases are published as a gzipped `gene-macos-arm64.gz` asset (with a matching
> `.sha256`); both the installer and `gene --update` download and decompress it,
> verifying the checksum when present. Linux/Intel builds aren't published — run from
> source there.

### From a source checkout

Run Gene from a Node checkout — the way you develop on it, and the only option off
macOS arm64. "Install" here means: get the dependencies on your `PATH`, clone the repo,
`npm install`.

### Dependencies

| Tool | Why | Needed when |
|---|---|---|
| **Node ≥ 26.3.0** | runtime (runs the `.ts` files directly; the [TUI](#tui-dashboard) needs 26.3.0, the console daemon runs on Node 24+) | always |
| **PostgreSQL ≥ 16** | state store — **optional**, only for the opt-in Postgres backend (`initdb` + `postgres` on `PATH`); the default embedded store needs nothing | optional |
| **git** | clones target repos + per-issue worktrees | always |
| **claude** (Claude Code) | the agent Gene dispatches (`claude -p`) | always |
| **gh CLI** | GitHub forge | issues targeting `github.com` |
| **glab CLI** | GitLab forge | issues targeting GitLab |
| **linear CLI** (`@schpet/linear-cli`) | Linear backend read/write | `GENE_TRACKER=linear` |

The **Trello** backend needs no extra CLI — the bundled `trello/` wrapper talks to
the REST API directly (just `TRELLO_API_KEY` + `TRELLO_TOKEN`).

### macOS (Homebrew)

```bash
# Node — Volta honours the version pinned in package.json (26.3.0)
curl https://get.volta.sh | bash && exec "$SHELL" -l
volta install node@26

# PostgreSQL 16+ — OPTIONAL (only for the opt-in Postgres backend; the default
# embedded store needs nothing). Keg-only, so put initdb/postgres on PATH.
brew install postgresql

# git, the agent, and the forge CLIs you need
brew install git gh                              # GitHub forge
brew install glab                                # GitLab forge (skip if unused)
curl -fsSL https://claude.ai/install.sh | bash  # claude (Claude Code)

# Linear backend only (skip for Trello)
npm install -g @schpet/linear-cli
```

### Linux (Debian / Ubuntu)

```bash
# Node 26 — NodeSource
curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
sudo apt-get install -y nodejs

# git is required; PostgreSQL is OPTIONAL (only for the opt-in Postgres backend —
# the default embedded store needs nothing). If you do want Postgres you only need
# the binaries; the auto-started system service can be stopped and its bin dir PATH-ed.
sudo apt-get install -y git
sudo apt-get install -y postgresql                              # optional — opt-in Postgres backend only
sudo systemctl disable --now postgresql   # optional — Gene doesn't use the system service

# GitHub CLI (gh) — official apt repo
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
sudo apt-get update && sudo apt-get install -y gh

# GitLab CLI (glab) — official prebuilt release binary (skip if unused)
GLAB_VERSION=1.102.0; arch="$(dpkg --print-architecture)"; tmp="$(mktemp -d)"
curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${arch}.tar.gz" | tar -xz -C "$tmp"
sudo install -m 0755 "$(find "$tmp" -type f -name glab | head -n1)" /usr/local/bin/glab

# The agent, and the Linear CLI (Linear backend only)
curl -fsSL https://claude.ai/install.sh | bash
npm install -g @schpet/linear-cli
```

> Fedora/RHEL: `sudo dnf install nodejs git gh` (add `postgresql-server` only for the
> opt-in Postgres backend). Arch: `sudo pacman -S nodejs npm git github-cli` (add
> `postgresql` for that backend). On any distro you can use [Volta](https://volta.sh)
> for Node and the prebuilt `glab`/`claude` installers above.

### Get Gene

```bash
git clone https://github.com/huksley/gene.git
cd gene
npm install                          # runtime deps (pg, pglite, opentui) + dev types
cp .env.example .env.development     # then edit it — see Setup below
```

Verify the toolchain before going further:

```bash
node --version            # ≥ 26.3.0
claude --version
git --version
gh --version              # and/or: glab --version
linear --version          # Linear backend only
initdb --version          # optional — only if you use the Postgres backend
```

Now continue with **[Setup](#setup)** to authenticate the CLIs and fill in
`.env.development`.

## Setup

Once the [dependencies](#installation) are installed and the repo is cloned,
authenticate the CLIs and configure your environment. The **Trello** backend needs
no CLI login — it uses `TRELLO_API_KEY` + `TRELLO_TOKEN` (see `trello/README.md`).

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

# 2. Configure (you copied .env.example → .env.development during Installation)
$EDITOR .env.development                            # set GENE_TRACKER, secrets, repo target

# 3. (Optional) pre-clone the team default repo(s)
npm run clone
```

`.env.development` is gitignored — put your secrets there. Everything has a safe
default; see `.env.example` for the full list. **`GENE_DRY_RUN` defaults to `false`** — Gene acts for real; set it to `true` for a log-only preview (no writes, no spawns).

## Usage

```bash
npm start               # TUI dashboard — the default way to run Gene (needs Node ≥26.3.0)
npm run console         # headless daemon poll loop, logs to stdout (runs on Node 24+)
npm run once            # a single scan, then exit  (great with GENE_DRY_RUN=true)
npm run ui              # just the TUI (needs Node ≥26.3.0)
npm run gene            # just the daemon poll loop (no TUI)
npm run clone           # pre-clone the team default repo(s)
npm run pg              # OPTIONAL local Postgres (port 5434) — only for the Postgres backend
npm run reset -- APP-1094            # reset one issue back to Todo   (stop the daemon first; see State store)
npm run reset -- APP-1094 --close-mr # ...and close its open MR/PR
npm run log -- linear:APP-1094       # show one issue's activity log (stop the daemon first; see State store)
npm run typecheck       # tsc --noEmit
```

`npm start` is the **default** — the TUI dashboard, with the embedded state store
opened in-process (no server to start). Prefer headless (CI, a server, or Node <
26.3.0)? `npm run console` runs the same poll loop with plain stdout logging and no
terminal UI. Because the embedded store is single-process, run `log` / `reset` with
the daemon stopped — or set `DATABASE_URL` / `PG*` to share a Postgres (see
[State store](#state-store)).

Gene acts for real by default. Set `GENE_DRY_RUN=true` in `.env.development` to
preview first: a dry-run scan prints exactly what it *would* do (decision, resolved
target repo + forge, branch, prompt size) without touching the tracker or the forge.

## TUI dashboard

The **default** way to run Gene — a Symphony-style terminal UI over the same
in-process daemon: a status header (agents N/MAX, uptime, current stage,
next-refresh countdown, tokens, scan counts) that stays pinned at the top across
both views, a live table of running/recent tickets (one-liner + stage each,
re-sortable), a per-ticket view (the last few actions pinned above a scrollable
live log), and inline agent cancellation / reset. The poll loop runs in the
*same* process as the renderer — so the data is live and cancel is immediate, no
separate observer or IPC.

```bash
npm start                       # dashboard (foreground) with the embedded store — one command, the default
npm start -- linear:APP-1094    # …focused on one issue (focus + dry-run flags pass through)
npm run ui                      # same dashboard (identical to npm start; the embedded store opens in-process)
```

`npm start` runs the dashboard in the foreground (see `ui.sh`) and opens the state
store in-process — no background server to manage. A full-screen TUI must own the
terminal, so it *can't* be hosted under a stdio multiplexer like `concurrently`
(which would leave the renderer with no TTY: a tiny window and a dead keyboard),
which is why `npm start` is a thin foreground wrapper rather than a multiplexed call.

Requires **Node ≥ 26.3.0** — OpenTUI's native renderer loads over FFI, which the
`ui` script enables (`--experimental-ffi`). On an older Node it prints install
guidance and exits cleanly; the headless daemon (`npm run console` / `npm run gene`)
is unaffected and still runs on Node 24+.

Keys: `↑↓` / `j` `k` navigate (selection is hidden until you move) · `enter` / `→`
open the selected ticket's log · `s` cycle the table sort (status → age → id; the
selected ticket stays selected) · `c` cancel the selected running agent (press again
within 2s to confirm) · `p` pause / resume the scan loop (paused stops polling the
tracker for new work but lets in-flight agents finish; `r` also resumes) · `r` reload
history from Postgres and wake the next scan · `esc` back out of a
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
- runtime dependencies stay few — the state store (`db.ts`) is **embedded PGlite** by
  default (zero-setup, in-process) with **`pg`** for an opt-in external Postgres; env
  parsing stays hand-rolled in `config.ts`.

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
- Native Node 24 TS — **no build**, `.ts` imports, `--env-file`; state is a
  **self-contained embedded store** (PGlite) by default, with `pg` for an opt-in
  external Postgres.
- Description **section enforcement is opt-in** (`GENE_REQUIRE_SECTIONS`) — off by
  default (free-form); when set, a missing section sends the issue to Blocked with a
  request to fill it in. See [Writing tickets](#writing-tickets).
