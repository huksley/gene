# Planning protocol + Shape A/B subcards + parent auto-completion

**Status:** Draft for review
**Date:** 2026-06-13
**Source:** meridian `682f168` (`scripts/ai-pipeline/pr-tracker.ts` Behavior B, `prompt.ts` planning protocol)

## Goal

Port the last three unported meridian capabilities into gene, adapted to gene's
tracker-neutral architecture rather than copied verbatim:

1. **Planning protocol** — for non-trivial cards, the agent plans (brainstorming →
   writing-plans) and waits for human approval before executing.
2. **Shape A / Shape B** — Shape A is one cohesive PR; Shape B splits the work into
   independently-shippable **subcards**, each running through the normal pipeline.
3. **Parent auto-completion** — when every subcard of a parent is Done, the daemon
   moves the parent to Done automatically.

## Why this is NOT a verbatim port

Meridian's `pr-tracker.ts` is Trello-specific and re-derives state gene already
tracks. Two gene facts let us do less work and stay backend-neutral:

- **Behavior A is already done.** `index.ts:487–516` already moves a merged change
  request's issue to `DONE_STATE`. So "is this subcard done?" reduces to "is it in
  `DONE_STATE`?" — no `gh pr view` polling, no checklist resolution.
- **`listIssues()` already fetches every Gene-labelled issue each scan.** Subcards
  carry the Gene label and so are already in that list. Parent-completion becomes a
  pass over data we already have.

## Decisions (from brainstorming)

- **Full scope**: all three pieces.
- **Parent link modeled natively per backend** (not a single shared convention),
  surfaced to the daemon through one neutral field so daemon logic stays uniform.

## Architecture overview

Three independent units:

| Unit | Where | Touches |
| --- | --- | --- |
| A. Planning protocol | `src/prompt.ts` (prompt text only) | none |
| B. Subcard creation (Shape B) | `src/prompt.ts` + each tracker's `writeBackSnippet`/`allowedTools` + Trello CLI | agent-driven |
| C. Parent auto-completion | new `src/subcards.ts`, called from `src/index.ts` scan loop | daemon-driven |

The seam tying B and C together is **one new neutral field on `Issue`:
`parentIdentifier?: string`**. Each tracker populates it during `listIssues()` using
its own native mechanism; the daemon never knows which.

---

## Unit A — Planning protocol (prompt-only)

Add a **"Scope sizing"** section to `buildPrompt`, ahead of the "pick ONE outcome"
block, mirroring meridian's heuristic:

A card is **non-trivial** when ANY of:
- 4+ items under `## Acceptance criteria`
- description longer than ~600 chars
- title/description contains: refactor, migrate, redesign, introduce, rewrite,
  "add feature", "build a", "implement a", overhaul
- work would plausibly touch 5+ files, excluding tests

For non-trivial scope the agent must:
1. Use `superpowers:brainstorming` to clarify intent.
2. Use `superpowers:writing-plans` to produce a checklist plan.
3. Choose **Shape A** or **Shape B** and complete the matching outcome.

**Mapping meridian → gene** (no new infra — gene already has these seams):

| meridian | gene equivalent |
| --- | --- |
| `ai:blocked` label | move to `env.BLOCKED_STATE` |
| `ai:done` label | move to `env.REVIEW_STATE` |
| `@claude approve` reply | existing `resume-from-block` intent + `${COMMAND_BASE} approve` directive |
| plan lives in Trello transcript | plan lives in issue transcript (gene already treats the transcript as the only memory) |

**Shape A** (most non-trivial cards): post the markdown-checkbox plan as a comment,
move to `BLOCKED_STATE`, exit. On approval, `resume-from-block` fires and the agent
uses `superpowers:executing-plans` to work the checklist on ONE branch → ONE change
request (existing outcome 3). Parallelizable steps may use
`superpowers:dispatching-parallel-agents` but still land on one branch.

This is the lowest-risk unit: pure prompt text, reuses the entire existing
blocked → reply → resume → review lifecycle.

---

## Unit B — Subcard creation (Shape B)

Add **outcome 5: Split into subcards** to the prompt, plus the constraint that a
subcard may not itself spawn subcards.

### Neutral field

```ts
// src/tracker/index.ts — Issue type
/** Identifier of this issue's parent, when it is a subcard; else undefined.
 *  Linear: native sub-issue parent. Trello: parsed from a `Parent:` desc line. */
parentIdentifier?: string;
```

### Per-backend "native" mechanism

**Linear — true native sub-issues.**
- Creation (agent, via CLI): `linear issue create --parent <parentIdentifier>
  --team <key> --title "..." --state "<Todo>"` then set the body. (`--parent` is
  supported by the installed `linear` CLI; verified.)
- Discovery (daemon): add `parent { identifier }` to the existing `GeneIssues`
  GraphQL query; map it to `parentIdentifier`. No description convention needed.

**Trello — desc-marker as the native per-child encoding.**
Trello cards have **no parent field**, so the only thing readable *per child* is the
description. Meridian put `Parent: <url>` as the first description line; we keep that
and treat it as Trello's native encoding.
- Creation (agent, via CLI): `trello create --list <todoListId> --name
  "[<parentShortLink>] ..." --desc "Parent: <parentUrl>\n\n<template>"`. The Trello
  CLI already has `create --list --name --desc`; no new command strictly required.
- Discovery (daemon): `toIssue` already maps `description: card.desc`; parse the
  first `Parent: <url>` line → extract the parent shortLink → `parentIdentifier`.

> **Open point for review:** meridian also created a human-facing `Subcards`
> checklist on the parent. With the desc-marker driving daemon logic, that checklist
> is now **optional decoration**. Options: (a) skip it; (b) add `checklist add`
> commands to the Trello CLI + client so the agent still creates it for human
> visibility. Recommendation: **(a) skip for v1**, revisit if humans miss it.

### Prompt additions (`src/prompt.ts`)

- Scope-sizing section (Unit A) ends by branching to Shape A or Shape B.
- Outcome 5 describes the Shape B steps with backend-appropriate creation, fed from
  `tracker.writeBackSnippet`/a new `tracker.subcardSnippet(issue)` so the per-backend
  CLI invocation stays in the tracker module (mirrors how `writeBackSnippet` already
  localizes per-backend commands). `allowedTools` already permits the needed CLI
  (`Bash(linear *)` / `Bash(node *)`).
- **No-nested rule:** when `issue.parentIdentifier` is set, the prompt states "you are
  a subcard — outcomes are 1–4 only, never 5." `buildPrompt` already has the `issue`,
  so this is a conditional block.

---

## Unit C — Parent auto-completion (daemon)

New module `src/subcards.ts`, single entry point called at the **end of each scan**
in `index.ts` `scanOnce` (after per-issue processing, like meridian runs
`runPrTracker()` last), receiving the already-fetched issue list so it makes **zero**
extra tracker calls for discovery:

```ts
export const completeFinishedParents = async (issues: Issue[]): Promise<void>
```

Algorithm:
1. Group issues by `parentIdentifier` (children only).
2. For each group, locate the parent issue in `issues` by `identifier`.
3. Skip if the parent is already in `DONE_STATE`, or any child can't be matched
   (defensive: a dangling `parentIdentifier` leaves the parent for human attention —
   mirrors meridian's "unresolvable → skip").
4. If **every** child is in `DONE_STATE` and there is ≥1 child: post a summary comment
   listing the subcards and `moveToState(parent, DONE_STATE)`, then
   `monitor.markIssueDone(parent.identifier)`.

Guard: only runs when `env.DONE_STATE` is configured (same precondition as Behavior A;
without a Done state there's nowhere to move the parent).

### Parent stays parked while children run

After splitting, the parent sits in `BLOCKED_STATE`. Two interactions to handle:

- **No user comment** → the parent is never re-dispatched (resume-from-block needs a
  new human comment); Unit C eventually completes it. ✓ works as-is.
- **User comments on the parent while children are open** → `resume-from-block` would
  dispatch the agent. `processIssue` should **skip dispatch for a parent with
  incomplete children** (it has children in `issues` not all in `DONE_STATE`) and
  instead leave it blocked. Add this guard in `index.ts` `processIssue`, reusing the
  same grouping helper from `src/subcards.ts` (export a `childStatus(issues)` helper).

---

## Testing

- `src/subcards.test.ts` (node:test, like `monitor.test.ts`): grouping; "all children
  done → parent moves"; "one child not done → no move"; "dangling parentIdentifier →
  skip"; "already-Done parent → no-op"; idempotency.
- Tracker mapping unit tests: Trello `Parent:`-line parsing → `parentIdentifier`;
  Linear `parent { identifier }` mapping.
- Prompt snapshot/assertion: non-trivial heuristic triggers the planning section;
  subcard issue (`parentIdentifier` set) suppresses outcome 5.
- Manual: `GENE_DRY_RUN=true` scan logs the intended parent moves without writing.

## Out of scope (v1)

- `gh pr view` polling for subcard merge state (gene's Done auto-move replaces it).
- Trello `Subcards` checklist creation (optional decoration — see open point).
- Nested subcards (explicitly forbidden, as in meridian).
- Multi-level parent rollup (a parent that is itself a subcard) — forbidden by the
  no-nested rule.

## File-by-file change list

| File | Change |
| --- | --- |
| `src/tracker/index.ts` | add `parentIdentifier?` to `Issue`; (optional) `subcardSnippet` to `Tracker` |
| `src/tracker/linear.ts` | add `parent { identifier }` to `GeneIssues` query + map it; subcard create snippet |
| `src/tracker/trello.ts` | parse `Parent:` desc line in `toIssue`; subcard create snippet |
| `trello/cli.ts` | (only if checklist decoration kept) `checklist` command |
| `src/prompt.ts` | scope-sizing section, Shape A/B, outcome 5, no-nested rule |
| `src/subcards.ts` | **new** — `completeFinishedParents`, `childStatus` |
| `src/subcards.test.ts` | **new** — unit tests |
| `src/index.ts` | call `completeFinishedParents` at end of `scanOnce`; parent-skip guard in `processIssue` |
