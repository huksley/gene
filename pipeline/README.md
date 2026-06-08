# AI Code Assistant — pipeline daemon

Polls the Trello "Dev" board's pipeline lists and dispatches cards to a Claude Code agent. The daemon spawns one `claude -p` per actionable card inside a card-scoped git worktree, and the agent posts back to Trello (PR link + label + list move).

## What this does today

- Every `AI_PIPELINE_POLL_INTERVAL_MS` (default 60s), scan:
  - `AI Code Assistant` (queue)
  - `In Process (AI)` (already being worked)
- For each card, decide what action *would* be taken:
  - `nothing` — no action needed (in-process and no new activity, blocked and waiting, etc.)
  - `ASK CLARIFICATION` — card description is missing `## Problem` or `## Acceptance criteria`
  - `START PROCESSING` — queued card has a valid description; ready to begin work
  - `RESUME` — card was `ai:blocked` and the user replied
  - `HANDLE FEEDBACK` — user posted a new comment during an active agent run
- Log only. **No Trello writes, no agent invocations.** Toggle `AI_PIPELINE_DRY_RUN=false` only after step 3+ ships.

## Setup

### 1. Generate Trello credentials (once)

1. Open https://trello.com/power-ups/admin/ and click **New** to create a power-up (any name). The dashboard then exposes an **API key**.
2. On the same page click **Token** to generate a personal token tied to your Trello account.
3. Add both to `.env.local` in this repo (gitignored):

```
TRELLO_API_KEY=...
TRELLO_TOKEN=...
```

Optional overrides:

```
AI_PIPELINE_BOARD_ID=69f464e71c2daae438c02a8b
AI_PIPELINE_POLL_INTERVAL_MS=60000
AI_PIPELINE_DEBOUNCE_MS=30000
```

### 1a. (Optional) Enable the webhook for low-latency reactivity

Polling alone runs every 60s; the webhook drops latency to a few seconds. Skip this section if 60s is fine for you — everything still works without it.

1. Get a **Trello OAuth secret** (different from the user token): it lives next to your API key at [trello.com/power-ups/admin/](https://trello.com/power-ups/admin/) under your power-up's API key. Add it to `.env.local`:

   ```
   TRELLO_API_SECRET=...
   ```

2. Start a Cloudflare Tunnel (free, no signup) pointing at the Next dev server:

   ```
   brew install cloudflared
   cloudflared tunnel --url http://localhost:3000
   ```

   Read the printed `https://<...>.trycloudflare.com` URL and add it to `.env.local`:

   ```
   AI_PIPELINE_TUNNEL_URL=https://your-tunnel.trycloudflare.com
   ```

3. Make sure `npm run dev` (or at least `npm run next`) is running so the endpoint is reachable.

4. Register the webhook with Trello:

   ```
   npm run pipeline:webhook-setup
   ```

   This calls `POST /webhooks` on the Trello API with your tunnel callback URL. Trello will HEAD the URL to verify it responds; the endpoint at `pages/api/ai-pipeline/trello-webhook.ts` returns 200 to HEAD requests.

   To list registered webhooks: `npm run pipeline:webhook-setup -- --list`. To delete: `-- --delete-all`.

### 2. Run

One-shot scan (useful for testing):

```
npm run pipeline -- --once
```

Run forever (poll every minute, wake early on webhook activity):

```
npm run pipeline
```

### Test a PR locally

Once the agent opens a PR, spin up the dev server against that branch. **The easiest path is by PR number** — you'll find the PR link in the agent's Trello comment:

```
npm run pipeline:test -- 42            # by PR number (recommended)
npm run pipeline:test -- hfCEqC4v      # by Trello short link (fallback)
```

Both end up in the same place — the agent's worktree at `.ai-pipeline/worktrees/<shortLink>/`. PR-number mode resolves the branch via `gh pr view`, then auto-detects the worktree.

What setup happens automatically:
- **Symlinks** `.env*` from the main checkout (config — rarely changes per-PR)
- **Clones** (APFS copy-on-write) `node_modules/` and `data/` from main — isolated, so migrations and Prisma regeneration in the worktree don't touch your main DB or installed packages
- Starts `npm run dev` in the worktree

Stop your main `npm run dev` first — ports collide.

If the agent's PR changed `prisma/schema.prisma`, apply migrations in the worktree before / after the dev server is up:

```
cd .ai-pipeline/worktrees/<shortLink>
npm run db:migrate:deploy
```

That hits the worktree's cloned DB only.

### Reset a card to fresh state

When you want the agent to fully redo a card (discard the worktree, branch, and any partial work):

```
npm run pipeline:reset -- hfCEqC4v              # remove worktree + branches + lock + AI labels
npm run pipeline:reset -- hfCEqC4v --close-pr   # also close any open PR for matching branches
```

Then move the card back to `AI Code Assistant` to re-trigger.

### Graceful shutdown

`Ctrl-C` the daemon and it'll sweep its active locks and remove the `ai:working` label from each card before exiting — no stuck labels on the board. If the daemon crashed hard (kill -9, power loss), labels may stick; clear them manually or with `pipeline:reset`.

Stop with Ctrl-C.

## Architecture (incremental — what's built vs. coming)

```
   ┌───────────────────────────────────────────────────────┐
   │                       Trello                          │
   └───────────┬─────────────────────────────┬─────────────┘
               │  webhook (Phase 2.2)        │  REST poll (Phase 2.1) ✅
               ▼                             │
   ┌──────────────────────────┐              │
   │ pages/api/ai-pipeline/   │              │
   │       trello-webhook.ts  │ (Phase 2.2)  │
   └──────────┬───────────────┘              │
              │                              │
              ▼                              ▼
   ┌─────────────────────────────────────────────────────┐
   │  scripts/ai-pipeline/index.ts (daemon)              │
   │   ✅ poll, decide, log                              │
   │   ⏳ debounce + card-keyed lock (Phase 2.2)         │
   │   ⏳ directive parser  (Phase 2.3)                  │
   └──────────┬──────────────────────────────────────────┘
              │ per card iteration (Phase 2.3+)
              ▼
   ┌─────────────────────────────────────────────────────┐
   │ claude -p ... (Phase 2.3)                           │
   └─────────────────────────────────────────────────────┘
```

## Identity convention

- **Lumi** (Trello member `698b0c4104d8d855eec1b65d`) = AI agent. All comments/labels/moves originating from the pipeline are attributed here.
- All other Trello users = humans. Comments from non-Lumi authors after the latest Lumi comment are the trigger for `resume-from-block` / `handle-user-feedback`.

## Card lifecycle (state machine)

| List | Meaning | How it gets here |
|---|---|---|
| `Backlog` / `To Do` | Not pipeline-managed | Manual |
| `AI Code Assistant` | Queue | Human moves card here |
| `In Process (AI)` | Agent working | Agent moves on `start-processing` |
| `Testing` | PR open, awaiting human review | Agent moves + applies `ai:done` |
| `Done - Ready for Prod` | Merged / approved | Human moves |

Labels:
- `ai:blocked` (orange) — agent posted a clarifying question; waiting for human reply
- `ai:done` (sky) — agent's PR is open

## Required card description sections

The agent refuses to start (would apply `ai:blocked` once writes are enabled) unless the description contains both:

```
## Problem
<non-empty body>

## Acceptance criteria
<non-empty body>
```

A `📋 Card template (for AI Code Assistant)` card lives in `Backlog` as a copy-paste source.
