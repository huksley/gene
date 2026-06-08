# Gene AI

AI agent which closes tickets.
From Linear to pull request in minutes, without touching a code.

Gene AI watches **Linear** for issues labelled **`Gene`**, and for each one dispatches a `claude ` agent 
— running in a dedicated git worktree — to do the work and open a change request. Each issue
chooses its own target repo (and therefore its forge) from a link in the issue, so
one Linear team can drive **GitLab** and **GitHub** repos side by side.

## How it works

```
                 ┌──────────────────────────── GeneAI (this repo, orchestrator) ──────┐
   Linear        │                                                                    │
  ┌───────┐ poll │  index.ts ─ scan ─► decide.ts ─► dispatch                          │
  │ Gene  │◄─────┤     │                                  │                           │
  │ label │      │     │ list issues (linear api)         │ withLock(ISSUE-ID)        │
  └───────┘      │     ▼                                  ▼                           │ 
                 │  linear.ts                        invoke.ts ── spawn ──► claude -p │
                 │                                        │  (in a worktree)          │
                 └────────────────────────────────────────┼───────────────────────────┘
                                                          │ git worktree off the clone
                               ┌──────────────────────────▼──────────────────────────┐
   GitLab / GitHub             │  repos/<repoPath>/                 (local clone)    │
  ┌──────────────┐  glab / gh  │  repos/.worktrees/<repoPath>/<ISSUE-ID> (per issue) │
  │ MR / PR      │◄────────────┤  the agent edits, commits, pushes, opens the MR/PR, │
  └──────────────┘             │  comments + moves the Linear state itself           │
                               └─────────────────────────────────────────────────────┘
```

The **orchestrator** only lists issues, decides, posts a start comment, moves the
issue to *In Progress*, and holds a per-issue lock. The **spawned agent** does
everything else — code changes, the merge/pull request, and the Linear write-back
(comments + the terminal state move).

## Lifecycle (Linear workflow states)

The lifecycle is driven by Linear **workflow states**:

| Phase | Mechanism |
|---|---|
| Eligible | label `Gene`, **assigned to you**, **and** state `Todo` |
| Picked up | orchestrator → **In Progress**, start comment, lock taken |
| Picked up — change request already attached | agent **continues** the open MR/PR (on its own branch) instead of starting fresh |
| Agent asks a question / proposes a plan | agent comments + → **Blocked** |
| Agent opens a change request | agent comments (MR/PR link) + → **In Review** |
| CI fails or a reviewer comments | daemon re-dispatches the agent to address it (back to **In Review**) |
| Human merges | manual → **Done** (out of scope) |

The `Gene` label is an **ownership tag and is never removed by the pipeline.**
Each scan watches `Gene` issues in **{Todo, In Progress, Blocked, In Review}** and
handles ongoing work — active conversations (In Progress / Blocked) and open change
requests (In Review) — *before* picking up new Todo work.

**Assignee filter.** Gene only works issues **assigned to you** — the Linear user the
`linear` CLI is authenticated as. Issues with the `Gene` label assigned to someone
else (or unassigned) are skipped and logged. Set `GENE_ASSIGNEE` to `any` to drop the
filter, or to a teammate's email to work on their behalf (default: `me`).

**Agent vs human comments.** The `linear` CLI posts as your user, so author identity
can't tell them apart. Every comment Gene writes carries a marker
(`GENE_AGENT_MARKER`, default `#gene-ai`); `decide.ts` treats marker-bearing
comments as Gene's, and a human comment newer than Gene's last one is the trigger
to resume / handle feedback.

**In-Review handling (`review.ts`).** Once a change request is open, the daemon
polls the forge for two signals before it touches new Todo work: a **failing
pipeline / Actions run**, and **new review comments** on the MR/PR (the same
marker tells Gene's own replies from a human's). On either, it re-dispatches the
agent to push a fix and reply. CI that's still **running**, or nothing new since
the last check, is a no-op — the daemon just moves on. A per-issue cursor (the
handled head SHA + newest comment, stored in Postgres via `db.ts`) ensures each
signal triggers exactly one dispatch, not one per poll.

**Draft pickup (`review.ts`).** If a Todo issue **already has an open change
request** — a human opened a **draft** MR/PR and handed it to Gene, or a previous
run opened one — Gene **continues** it instead of starting from scratch. It finds
the change request from the issue's Linear attachments (then description, then
comments), matched to the resolved repo and looked up by number — so it works even
when the MR/PR lives on a **human-named branch**, not Linear's auto-link branch.
The agent checks out *that* branch, reads the diff, the CI result and any review
comments, addresses the pipeline failures / feedback below, finishes whatever the
change request is still missing, and — once the work is complete and CI is green —
marks the draft **ready for review** and moves the issue to **In Review** (or back
to **Blocked** if it needs a decision). This is the same machinery as In-Review
handling, just with "there's queued work here" rather than "wait for a new signal".

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

Issues with **no link** fall back to a per-team default repo (built-in: `CLOUD →
datacrunch/nest.datacrunch.io`), overridable via the `GENE_REPO_MAP` env var (a
JSON object of `team key → repo URL`). All resolution logic lives in `src/repos.ts`.

## Two-repo model

- **geneai** (this repo) — the orchestrator. All pipeline code is in `src/`.
- **target repos** — cloned under `repos/<repoPath>/` (gitignored) and kept.
  A repo is cloned **on demand** the first time an issue targets it; `npm run clone`
  pre-clones the team defaults so the common path is warm. Per-issue worktrees are
  created at `repos/.worktrees/<repoPath>/<ISSUE-ID>`, branched off the base.
  Runtime state — locks and the PGlite state store (`pgdata/`) — lives in `.gene/`
  (gitignored).

## Setup

Prerequisites: Node 24 (via [Volta](https://volta.sh) — pinned in `package.json`),
and the `linear`, `claude`, `git`, and `glab` and/or `gh` CLIs on `PATH`.

> Prefer isolation? The whole toolchain is packaged as a microVM — see
> [`sandbox/`](sandbox/README.md) to run `claude -p` agents in a throwaway VM
> (microsandbox) instead of installing the CLIs on your host.

```bash
# 1. Authenticate the CLIs (one-time, interactive — run with a leading `!` here)
glab auth login --hostname gitlab.datacrunch.io   # accept "use glab as a git credential helper"
gh auth login                                      # only if any issue targets a GitHub repo
linear login                                       # if not already logged in
claude  /login                                     # OAuth / Max session

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
npm start               # run the daemon forever (poll loop)
npm run once            # a single scan, then exit  (great with GENE_DRY_RUN=true)
npm run clone           # pre-clone the team default repo(s)
npm run reset -- CLOUD-1094            # reset one issue back to Todo
npm run reset -- CLOUD-1094 --close-mr # ...and close its open MR/PR
npm run typecheck       # tsc --noEmit
```

Go live by setting `GENE_DRY_RUN=false` in `.env.development`. A dry-run scan prints
exactly what it *would* do (decision, resolved target repo + forge, branch, prompt
size) without touching Linear or the forge.

## Runtime: native TypeScript, minimal deps

Node 24 runs the `.ts` files directly (type-stripping — no build step), so:

- relative imports **must** include the `.ts` extension (`import … from "./x.ts"`);
- no TypeScript-only runtime constructs (enums, namespaces, constructor parameter
  properties) — strip-only mode rejects them;
- env is loaded by `node --env-file-if-exists=.env.development` (in the npm scripts);
- the only runtime dependency is **PGlite** (`@electric-sql/pglite`) — an embedded
  Postgres for the daemon's persistent state (`db.ts`); env parsing stays hand-rolled
  in `config.ts`.

## File map

```
src/
  index.ts        daemon: scan → decide → dispatch (--once supported)
  config.ts       env + constants (hand-rolled, no zod)
  db.ts           embedded Postgres (PGlite) state store (.gene/pgdata)
  logger.ts       timestamped server logger
  linear.ts       Linear access (read via `linear api`, write via `linear issue …`)
  decide.ts       pure (issue, comments) → Action
  review.ts       In-Review watchdog + draft pickup: find the open MR/PR, decide re-dispatch
  directives.ts   `@gene approve|redo|stop|retry` parser
  prompt.ts       builds the agent's prompt (the full contract it runs under)
  invoke.ts       worktree management + spawns `claude -p`, renders stream-json
  lock.ts         per-issue file lock (keyed by ISSUE-ID), stale-PID reclamation
  attachments.ts  best-effort staging of Linear image attachments into the worktree
  reset.ts        reset one issue (worktree/branch/lock + back to Todo)
  repos.ts        per-issue link → RepoTarget (forge/host/repoPath/subdir + defaults)
  clone.ts        pre-clone the team default repo(s) (npm run clone)
  forge/
    index.ts      Forge interface + selectForge(name)
    gitlab.ts     glab implementation
    github.ts     gh implementation
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

## Design notes

- Lifecycle is driven by Linear **states**; the `Gene` label is an ownership tag and
  is never removed.
- Agent identity is established by a **comment marker** (the CLI authenticates as a
  single user, so author id can't distinguish Gene from a human).
- **Per-issue targeting**: the forge and repo come from a link in the issue, so a
  single team spans multiple repos and both forges without per-repo config.
- **Two-repo** model (orchestrator vs cloned targets); worktrees branch off the clone.
- Native Node 24 TS — **no build**, `.ts` imports, `--env-file`; **one runtime dep**
  (PGlite, embedded Postgres for state).
- Description **section enforcement is off** by default (real tickets are free-form).
