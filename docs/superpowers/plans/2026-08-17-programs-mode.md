# Programs Mode (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recurring "programs" to Gene — a program is a tracker ticket carrying a configurable `Program` label with `## Trigger` / `## Workflow` / `## Acceptance criteria` sections; Phase 1 delivers manual firing from the TUI, an ephemeral agent run that writes back to the ticket (never opens a change request), a clarification-park/resume loop, and a lifecycle that always restores the ticket to its resting state (never Done).

**Architecture:** Programs ride the existing daemon. A new `scanPrograms` pass runs alongside `scanOnce` in the poll loop, fetching `Program`-labelled tickets via a new `tracker.listPrograms(label)` and excluding them from the coding path. A pure `decideProgramAction` maps ticket state + a manual fire queue to an action (`fire`/`restart`/`resume`/`resume-interrupted`/`nothing`). `dispatchProgram` runs the agent under the existing per-issue file lock (`withLock`) — the lock is the sole mutual-exclusion mechanism; a new `program_state` table records lifecycle status (resting state, last result, source) for observability only, never as a lock. The agent runs in a git worktree when the ticket links a repo, else in a scratch dir under `.gene/programs/<id>` with no git. On completion `finishProgramRun` restores the recorded resting state (coerced away from Done) unless the ticket was parked in Blocked or the run was cancelled. The TUI marks program rows with ⟳, exposes a programs filter, and fires/restarts via `g` (arm→confirm).

**Tech Stack:** TypeScript executed by Node ≥26.3.0 via strip-only type elision (`--experimental-ffi`); `@opentui/core` TUI; embedded PGlite (default) or external Postgres via `pg`; tests via `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-16-programs-mode-design.md`

## Global Constraints

- **Runtime:** Node ≥26.3.0, run with `--experimental-ffi` (see `package.json` `volta.node` = 26.3.0 and the `gene` script). Do not add dependencies.
- **TypeScript is strip-only:** Node erases types, it does not compile them. NO parameter properties, NO `enum`, NO decorators, NO `namespace`. `npm run typecheck` passing does **not** prove it runs — after any change to a spawn/runtime path, smoke-test under node (`npm run build` then run the binary, or `node --experimental-ffi ... src/index.ts --once`).
- **Migrations are idempotent:** schema changes go in `src/db.ts`'s `SCHEMA` template using `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Never a destructive migration.
- **Tests:** `node --test 'src/**/*.test.ts'`; single file `node --test src/<file>.test.ts`. Pure functions + hand-rolled stubs for `Tracker`/`Forge`; no network, no real DB in unit tests. Importing `src/config.ts` in a test is safe (it only `exit(1)`s on invalid env; unset env uses defaults).
- **Never open a change request from a program run.** Programs write back to the ticket and may create child tickets (carrying the `Gene` label, never `Program`). No `git push`, no MR/PR.
- **Never move a program to the Done state.** A finished run restores the resting state; if that would be Done (or Done is unset), fall back to `TRIGGER_STATE`.
- **Config/secrets:** only edit `.env.example` / `.gene.config.example` / `README.md` for docs. `.env.development` is user-owned — never touch it.
- **Do not commit** unless the user explicitly confirms; if committing, branch off `main` first. The per-task `git commit` steps below are the intended unit of work for the executor, but the *first* commit requires the user's go-ahead per this constraint.

---

### Task 1: Program config keys + exported section gate

Adds the three `PROGRAM_*` config keys and exports the currently-private section-detection helper so the program flow can reuse it.

**Files:**
- Modify: `src/config.ts` (after line 149, `REQUIRE_SECTIONS: list("GENE_REQUIRE_SECTIONS"),`; and a const just above `export const env` at line 98)
- Modify: `src/decide.ts` (line 31, `const findMissingSections` → `export const findMissingSections`)
- Test: `src/decide.test.ts` (new)

**Interfaces:**
- Produces: `env.PROGRAM_LABEL: string`, `env.PROGRAM_REQUIRE_SECTIONS: string[]`, `env.PROGRAM_ALLOWED_TOOLS: string[]`; `findMissingSections(desc: string, required: string[]): string[]` (exported).

- [ ] **Step 1: Write the failing test**

Create `src/decide.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { findMissingSections } from "./decide.ts";

const PROGRAM_SECTIONS = ["## Trigger", "## Workflow", "## Acceptance criteria"];

test("findMissingSections: all program sections present and non-empty → none missing", () => {
  const desc = [
    "## Trigger",
    "Manual fire.",
    "## Workflow",
    "Do the thing.",
    "## Acceptance criteria",
    "It is done."
  ].join("\n");
  assert.deepEqual(findMissingSections(desc, PROGRAM_SECTIONS), []);
});

test("findMissingSections: a missing heading is reported", () => {
  const desc = "## Trigger\nx\n## Acceptance criteria\ny";
  assert.deepEqual(findMissingSections(desc, PROGRAM_SECTIONS), ["## Workflow"]);
});

test("findMissingSections: a present-but-empty section is reported", () => {
  const desc = "## Trigger\nx\n## Workflow\n\n## Acceptance criteria\ny";
  assert.deepEqual(findMissingSections(desc, PROGRAM_SECTIONS), ["## Workflow"]);
});

test("findMissingSections: empty description reports all", () => {
  assert.deepEqual(findMissingSections("", PROGRAM_SECTIONS), PROGRAM_SECTIONS);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/decide.test.ts`
Expected: FAIL — `findMissingSections` is not exported (`SyntaxError: The requested module './decide.ts' does not provide an export named 'findMissingSections'`).

- [ ] **Step 3: Export the helper and add the config keys**

In `src/decide.ts` line 31, change the declaration to export it:

```ts
export const findMissingSections = (desc: string, required: string[]): string[] => {
```

In `src/config.ts`, add just above `export const env = {` (line 98):

```ts
// Program sections default (used when GENE_PROGRAM_REQUIRE_SECTIONS is unset). list()
// returns [] when unset, so the fallback is computed here rather than in the helper.
const DEFAULT_PROGRAM_SECTIONS = ["## Trigger", "## Workflow", "## Acceptance criteria"];
const programSections = list("GENE_PROGRAM_REQUIRE_SECTIONS");
```

Then inside the `env` object, immediately after `REQUIRE_SECTIONS: list("GENE_REQUIRE_SECTIONS"),` (line 149):

```ts
  // Programs mode. A program is a ticket carrying PROGRAM_LABEL (tracker-namespaced,
  // like LABEL) with ## Trigger / ## Workflow / ## Acceptance criteria sections. It
  // runs on demand, writes back to the ticket, and never opens a change request.
  PROGRAM_LABEL: str(`${TP}PROGRAM_LABEL`, "Program"),
  // Sections a program ticket must contain (non-empty) before it will fire. Empty list
  // ⇒ no gate. Global (not tracker-namespaced) since sections are Markdown, not tracker
  // semantics.
  PROGRAM_REQUIRE_SECTIONS: programSections.length > 0 ? programSections : DEFAULT_PROGRAM_SECTIONS,
  // Extra tools granted to a program agent on top of BASE + tracker (+ forge, when the
  // program links a repo). e.g. "Bash(pup *),Bash(datadog *)". Comma-separated.
  PROGRAM_ALLOWED_TOOLS: list("GENE_PROGRAM_ALLOWED_TOOLS"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/decide.test.ts`
Expected: PASS (4/4).

Also run `npm run typecheck` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/decide.ts src/config.ts src/decide.test.ts
git commit -m "feat(programs): add PROGRAM_* config + export findMissingSections"
```

---

### Task 2: `listPrograms` on the Tracker + scan exclusion helper

Adds a program-listing method to the tracker abstraction and both backends, and a pure helper that excludes program tickets from the coding scan (wired into `scanOnce`). A ticket carrying both `Gene` and `Program` is treated as a program and kept out of coding work.

**Files:**
- Modify: `src/tracker/index.ts` (the `Tracker` interface — add `listPrograms`)
- Modify: `src/tracker/linear.ts` (implement `listPrograms`, mirroring `listIssues`)
- Modify: `src/tracker/trello.ts` (implement `listPrograms`, mirroring `listIssues` at lines 225-230)
- Create: `src/programs.ts` (pure `excludePrograms`; grows in Tasks 4)
- Modify: `src/index.ts` (`scanOnce` — accept + apply the exclusion set)
- Test: `src/programs.test.ts` (new)

**Interfaces:**
- Consumes: `env.PROGRAM_LABEL` (Task 1); `Issue` from `src/tracker/index.ts`.
- Produces:
  - `Tracker.listPrograms(label: string): Promise<Issue[]>`
  - `excludePrograms(issues: Issue[], programIds: Set<string>): Issue[]` (from `src/programs.ts`)

- [ ] **Step 1: Write the failing test**

Create `src/programs.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Issue } from "./tracker/index.ts";
import { excludePrograms } from "./programs.ts";

const issue = (identifier: string): Issue => ({
  id: `id-${identifier}`,
  identifier,
  title: identifier,
  description: "",
  stateName: "Todo",
  url: `https://example/${identifier}`,
  branchName: identifier,
  assigneeId: "u1",
  updatedAt: "2026-08-16T00:00:00.000Z"
});

test("excludePrograms drops tickets whose identifier is in the program set", () => {
  const all = [issue("ENG-1"), issue("ENG-2"), issue("ENG-3")];
  const out = excludePrograms(all, new Set(["ENG-2"]));
  assert.deepEqual(out.map(i => i.identifier), ["ENG-1", "ENG-3"]);
});

test("excludePrograms with an empty set is a no-op", () => {
  const all = [issue("ENG-1"), issue("ENG-2")];
  assert.deepEqual(excludePrograms(all, new Set()).map(i => i.identifier), ["ENG-1", "ENG-2"]);
});
```

> Note: match the `Issue` factory to the real `Issue` shape in `src/tracker/index.ts`. Read it first; the fields above mirror `src/subcards.test.ts`'s factory — add/remove fields so it type-checks (do not invent fields).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/programs.test.ts`
Expected: FAIL — cannot find module `./programs.ts`.

- [ ] **Step 3: Create the helper and the tracker method**

Create `src/programs.ts`:

```ts
/**
 * Programs mode — pure helpers and the manual-fire queue. A program is a tracker
 * ticket labelled PROGRAM_LABEL; it runs on demand, writes back to the ticket, and
 * never opens a change request. Kept dependency-light and mostly pure so the lifecycle
 * is unit-testable against stub trackers (see programs.test.ts). The impure dispatch
 * lives in index.ts.
 */
import type { Issue } from "./tracker/index.ts";

/** Drop program tickets from a coding-scan issue list (by identifier). */
export const excludePrograms = (issues: Issue[], programIds: Set<string>): Issue[] =>
  issues.filter(i => !programIds.has(i.identifier));
```

In `src/tracker/index.ts`, add to the `Tracker` interface right after the `listIssues()` signature:

```ts
  /** List tickets carrying the program label (mirrors listIssues but for PROGRAM_LABEL). */
  listPrograms(label: string): Promise<Issue[]>;
```

In `src/tracker/trello.ts`, add after `listIssues()` (lines 225-230) — mirror it exactly, taking the label as a parameter:

```ts
  async listPrograms(label: string): Promise<Issue[]> {
    const want = label.toLowerCase();
    const cards = await this.allCards();
    return cards.filter(c => c.labels.some(l => l.name.toLowerCase() === want)).map(toIssue);
  }
```

> Read `listIssues()` in trello.ts first and copy its exact body (the card-fetch call may be named differently than `this.allCards()` above); change only the label source from `env.LABEL.toLowerCase()` to `label.toLowerCase()`.

In `src/tracker/linear.ts`, add a `listPrograms` that duplicates `listIssues()` but passes the parameter label instead of `env.LABEL`:

```ts
  async listPrograms(label: string): Promise<Issue[]> {
    // Duplicate of listIssues() with the label taken as a parameter. Copy the exact
    // GraphQL call + node traversal from listIssues() above; swap env.LABEL → label.
    const data = await api<{ issues: { nodes: RawIssue[] } }>(LIST_QUERY, { label });
    return data.issues.nodes.map(toIssue);
  }
```

> Read `listIssues()` in linear.ts and mirror its exact return-shape traversal + variable names (`RawIssue`/`LIST_QUERY`/`api` may differ). Only the label binding changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/programs.test.ts`
Expected: PASS (2/2). Run `npm run typecheck` — expected: clean (both trackers now satisfy the interface).

- [ ] **Step 5: Wire the exclusion into `scanOnce`**

In `src/index.ts`, import the helper (add to the existing import block near the top):

```ts
import { excludePrograms } from "./programs.ts";
```

Change `scanOnce`'s signature (line ~736) to accept the program-id set, and apply it right after the issues are fetched (line ~739):

```ts
const scanOnce = async (
  issueFilter?: (issue: Issue) => boolean,
  excludeIdentifiers: Set<string> = new Set()
): Promise<boolean> => {
  let all = await tracker.listIssues();
  all = excludePrograms(all, excludeIdentifiers);
  // ...unchanged: isAssignedToOwner filter + bucketing...
```

> `scanOnce` is not unit-tested (it does network I/O); its exclusion is covered by the `excludePrograms` unit test above plus the smoke test in Task 8. The default `new Set()` keeps every existing caller (e.g. `--once`, `requestScan`) unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/tracker/index.ts src/tracker/linear.ts src/tracker/trello.ts src/programs.ts src/programs.test.ts src/index.ts
git commit -m "feat(programs): listPrograms on trackers + scanOnce exclusion"
```

---

### Task 3: `program_state` table + accessors + resting-state guard

Persists per-program lifecycle status (resting state, last fired, last result, source) for observability, and the pure guard that keeps a finished run from landing in Done.

**Files:**
- Modify: `src/db.ts` (the `SCHEMA` template, near the `issue_log` table at line ~59)
- Create: `src/program-state.ts`
- Test: `src/program-state.test.ts` (new)

**Interfaces:**
- Consumes: `getDb()` from `src/db.ts`; `env.DONE_STATE`, `env.TRIGGER_STATE` (Task 1/config).
- Produces:
  - `type ProgramState = { restingState?: string; lastFiredAt?: string; lastResult?: string; lastSource?: string }`
  - `readProgramState(tracker: string, identifier: string): Promise<ProgramState | null>`
  - `writeProgramState(tracker: string, identifier: string, state: ProgramState): Promise<void>` (upsert, COALESCE-merges so a partial write never clobbers unrelated columns)
  - `safeRestingState(resting: string | undefined, doneState: string | undefined, triggerState: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/program-state.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeRestingState } from "./program-state.ts";

test("safeRestingState returns the recorded resting state", () => {
  assert.equal(safeRestingState("Backlog", "Done", "Todo"), "Backlog");
});

test("safeRestingState never returns the Done state", () => {
  assert.equal(safeRestingState("Done", "Done", "Todo"), "Todo");
});

test("safeRestingState falls back to trigger when resting is missing", () => {
  assert.equal(safeRestingState(undefined, "Done", "Todo"), "Todo");
});

test("safeRestingState with Done unset still returns a real resting state", () => {
  assert.equal(safeRestingState("In Review", undefined, "Todo"), "In Review");
});
```

> Only the pure `safeRestingState` is unit-tested. `readProgramState`/`writeProgramState` are DB round-trips (embedded PGlite); following the existing precedent (`writeCursor`/`readCursor` in `src/review.ts` have no unit test), they are verified by typecheck + the Task 8 smoke test, not a unit test.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/program-state.test.ts`
Expected: FAIL — cannot find module `./program-state.ts`.

- [ ] **Step 3: Add the table and the accessors**

In `src/db.ts`, inside the `SCHEMA` template string, after the `issue_log` table block (around line 59), add:

```sql
  CREATE TABLE IF NOT EXISTS program_state (
    tracker       TEXT NOT NULL,
    identifier    TEXT NOT NULL,
    resting_state TEXT,
    last_fired_at TIMESTAMPTZ,
    last_result   TEXT,
    last_source   TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tracker, identifier)
  );
```

Create `src/program-state.ts`:

```ts
/**
 * Per-program lifecycle state. This is OBSERVABILITY/status, NOT a lock — mutual
 * exclusion for a running program is the per-issue file lock (lock.ts `withLock`),
 * exactly as coding runs use it. The upsert COALESCE-merges: a "fire" write records
 * restingState/lastFiredAt/lastSource; a "finish" write records lastResult/lastFiredAt
 * without needing to re-supply (and thus clobber) restingState.
 */
import { getDb } from "./db.ts";

export type ProgramState = {
  restingState?: string;
  lastFiredAt?: string;
  lastResult?: string;
  lastSource?: string;
};

type Row = {
  resting_state: string | null;
  last_fired_at: string | null;
  last_result: string | null;
  last_source: string | null;
};

export const readProgramState = async (
  tracker: string,
  identifier: string
): Promise<ProgramState | null> => {
  const db = await getDb();
  const res = await db.query<Row>(
    "SELECT resting_state, last_fired_at, last_result, last_source FROM program_state WHERE tracker = $1 AND identifier = $2",
    [tracker, identifier]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    restingState: row.resting_state ?? undefined,
    lastFiredAt: row.last_fired_at ?? undefined,
    lastResult: row.last_result ?? undefined,
    lastSource: row.last_source ?? undefined
  };
};

export const writeProgramState = async (
  tracker: string,
  identifier: string,
  state: ProgramState
): Promise<void> => {
  const db = await getDb();
  await db.query(
    `INSERT INTO program_state (tracker, identifier, resting_state, last_fired_at, last_result, last_source, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (tracker, identifier) DO UPDATE SET
       resting_state = COALESCE(EXCLUDED.resting_state, program_state.resting_state),
       last_fired_at = COALESCE(EXCLUDED.last_fired_at, program_state.last_fired_at),
       last_result   = COALESCE(EXCLUDED.last_result,   program_state.last_result),
       last_source   = COALESCE(EXCLUDED.last_source,   program_state.last_source),
       updated_at    = now()`,
    [
      tracker,
      identifier,
      state.restingState ?? null,
      state.lastFiredAt ?? null,
      state.lastResult ?? null,
      state.lastSource ?? null
    ]
  );
};

/** The state to restore a finished run to — never Done (nor undefined). */
export const safeRestingState = (
  resting: string | undefined,
  doneState: string | undefined,
  triggerState: string
): string => {
  if (!resting) return triggerState;
  if (doneState && resting === doneState) return triggerState;
  return resting;
};
```

> Confirm the `Db.query` generic + `.rows` shape against `src/review.ts`'s `readCursor` (line ~63) and match it exactly (e.g. `db.query<Row>(sql, params)` returning `{ rows: Row[] }`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/program-state.test.ts`
Expected: PASS (4/4). Run `npm run typecheck` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/program-state.ts src/program-state.test.ts
git commit -m "feat(programs): program_state table + accessors + resting-state guard"
```

---

### Task 4: Program decision (pure) + fire queue + section/child/detail helpers

The heart of the lifecycle: a pure `decideProgramAction` mapping ticket state + fire queue to an action, the module-level manual-fire queue, and pure helpers for child-ticket detection and detail-view section extraction. All unit-tested.

**Files:**
- Modify: `src/programs.ts` (add to the file from Task 2)
- Test: `src/programs.test.ts` (extend)

**Interfaces:**
- Consumes: `env.ACTIVE_STATE`, `env.BLOCKED_STATE`, `env.TRACKER` (config); `commentIsIgnored` from `src/ignore.ts`; `parseDirective` from `src/directives.ts`; `Comment`, `Issue` from `src/tracker/index.ts`.
- Produces:
  - `type ProgramSource = "manual" | "trigger"`
  - `type ProgramAction = { kind: "nothing"; reason: string } | { kind: "fire"; source: ProgramSource } | { kind: "restart"; source: ProgramSource } | { kind: "resume"; latestUserCommentId: string } | { kind: "resume-interrupted" } | { kind: "stop" }`
  - `decideProgramAction(program: Issue, comments: Comment[], opts: { firePending: boolean; source?: ProgramSource; runInFlight: boolean }): ProgramAction`
  - `fireProgram(identifier: string, source?: ProgramSource): void`
  - `hasFireRequest(identifier: string): boolean`
  - `takeFireRequest(identifier: string): ProgramSource | undefined`
  - `childTicketIds(geneIssues: Issue[], parentIdentifier: string): string[]`
  - `newChildIdentifiers(current: string[], alreadyLogged: string[]): string[]`
  - `type ProgramSections = { trigger: string; workflow: string; acceptance: string }`
  - `extractProgramSections(description: string): ProgramSections`

- [ ] **Step 1: Write the failing tests**

Append to `src/programs.test.ts`:

```ts
import {
  decideProgramAction,
  fireProgram,
  hasFireRequest,
  takeFireRequest,
  childTicketIds,
  newChildIdentifiers,
  extractProgramSections
} from "./programs.ts";
import type { Comment } from "./tracker/index.ts";
import { env } from "./config.ts";

const prog = (stateName: string): Issue => ({ ...issue("PRG-1"), stateName });
const comment = (id: string, isAgent: boolean, createdAt: string, body = "hi"): Comment => ({
  id,
  body,
  isAgent,
  createdAt,
  author: isAgent ? "gene" : "human"
});

test("decide: resting program with no fire → nothing", () => {
  const a = decideProgramAction(prog("Todo"), [], { firePending: false, runInFlight: false });
  assert.equal(a.kind, "nothing");
});

test("decide: fire pending, nothing running → fire", () => {
  const a = decideProgramAction(prog("Todo"), [], { firePending: true, source: "manual", runInFlight: false });
  assert.deepEqual(a, { kind: "fire", source: "manual" });
});

test("decide: fire pending while running → restart", () => {
  const a = decideProgramAction(prog(env.ACTIVE_STATE), [], { firePending: true, source: "manual", runInFlight: true });
  assert.deepEqual(a, { kind: "restart", source: "manual" });
});

test("decide: ACTIVE but nothing running locally → resume-interrupted", () => {
  const a = decideProgramAction(prog(env.ACTIVE_STATE), [], { firePending: false, runInFlight: false });
  assert.equal(a.kind, "resume-interrupted");
});

test("decide: ACTIVE and running → nothing", () => {
  const a = decideProgramAction(prog(env.ACTIVE_STATE), [], { firePending: false, runInFlight: true });
  assert.equal(a.kind, "nothing");
});

test("decide: BLOCKED with a new user reply after the agent → resume", () => {
  const comments = [
    comment("c1", true, "2026-08-16T10:00:00.000Z"),
    comment("c2", false, "2026-08-16T11:00:00.000Z", "!gene approve")
  ];
  const a = decideProgramAction(prog(env.BLOCKED_STATE), comments, { firePending: false, runInFlight: false });
  assert.deepEqual(a, { kind: "resume", latestUserCommentId: "c2" });
});

test("decide: BLOCKED with no new reply → nothing", () => {
  const comments = [comment("c1", true, "2026-08-16T10:00:00.000Z")];
  const a = decideProgramAction(prog(env.BLOCKED_STATE), comments, { firePending: false, runInFlight: false });
  assert.equal(a.kind, "nothing");
});

test("decide: BLOCKED with a !gene stop reply → stop", () => {
  const comments = [
    comment("c1", true, "2026-08-16T10:00:00.000Z"),
    comment("c2", false, "2026-08-16T11:00:00.000Z", "!gene stop")
  ];
  const a = decideProgramAction(prog(env.BLOCKED_STATE), comments, { firePending: false, runInFlight: false });
  assert.equal(a.kind, "stop");
});

test("fire queue: enqueue, observe, take-once", () => {
  fireProgram("PRG-9", "manual");
  assert.equal(hasFireRequest("prg-9"), true); // case-insensitive
  assert.equal(takeFireRequest("PRG-9"), "manual");
  assert.equal(takeFireRequest("PRG-9"), undefined); // drained
  assert.equal(hasFireRequest("PRG-9"), false);
});

test("childTicketIds filters by parentIdentifier", () => {
  const kids = [
    { ...issue("K-1"), parentIdentifier: "PRG-1" },
    { ...issue("K-2"), parentIdentifier: "OTHER" },
    { ...issue("K-3"), parentIdentifier: "PRG-1" }
  ] as Issue[];
  assert.deepEqual(childTicketIds(kids, "PRG-1"), ["K-1", "K-3"]);
});

test("newChildIdentifiers returns only ones not already logged", () => {
  assert.deepEqual(newChildIdentifiers(["K-1", "K-2", "K-3"], ["K-1"]), ["K-2", "K-3"]);
});

test("extractProgramSections pulls each section body", () => {
  const desc = "## Trigger\nfire it\n## Workflow\ndo x\ndo y\n## Acceptance criteria\ndone";
  assert.deepEqual(extractProgramSections(desc), {
    trigger: "fire it",
    workflow: "do x\ndo y",
    acceptance: "done"
  });
});

test("extractProgramSections tolerates missing sections", () => {
  assert.deepEqual(extractProgramSections("## Trigger\nx"), { trigger: "x", workflow: "", acceptance: "" });
});
```

> Confirm `Comment`'s real fields in `src/tracker/index.ts` and adjust the `comment()` factory (the fields `id`/`body`/`isAgent`/`createdAt`/`author` mirror how `src/decide.ts` reads comments — remove `author` if the type lacks it). `parentIdentifier` is an existing optional field on `Issue` (used by `src/subcards.ts`); confirm its exact name.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/programs.test.ts`
Expected: FAIL — the new exports don't exist yet.

- [ ] **Step 3: Implement the decision, queue, and helpers**

Append to `src/programs.ts`:

```ts
import { env } from "./config.ts";
import { commentIsIgnored } from "./ignore.ts";
import { parseDirective } from "./directives.ts";
import type { Comment } from "./tracker/index.ts";

export type ProgramSource = "manual" | "trigger";

export type ProgramAction =
  | { kind: "nothing"; reason: string }
  | { kind: "fire"; source: ProgramSource }
  | { kind: "restart"; source: ProgramSource }
  | { kind: "resume"; latestUserCommentId: string }
  | { kind: "resume-interrupted" }
  | { kind: "stop" };

// --- Manual-fire queue (Phase 1: manual only; triggers enqueue here in Phase 2) ----
const pendingFires = new Map<string, ProgramSource>();

/** Enqueue a fire for a program (idempotent per identifier). */
export const fireProgram = (identifier: string, source: ProgramSource = "manual"): void => {
  pendingFires.set(identifier.toLowerCase(), source);
};

export const hasFireRequest = (identifier: string): boolean =>
  pendingFires.has(identifier.toLowerCase());

/** Remove and return a pending fire's source (undefined if none). Consuming it
 *  guarantees exactly one dispatch per request. */
export const takeFireRequest = (identifier: string): ProgramSource | undefined => {
  const key = identifier.toLowerCase();
  const source = pendingFires.get(key);
  if (source !== undefined) pendingFires.delete(key);
  return source;
};

// --- Pure decision ------------------------------------------------------------------
const latestAgentComment = (comments: Comment[]): Comment | undefined => {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    if (comments[i]!.isAgent) return comments[i];
  }
  return undefined;
};

const newUserCommentsAfter = (comments: Comment[], afterIso: string | undefined): Comment[] =>
  comments.filter(
    c => !c.isAgent && (afterIso === undefined || c.createdAt > afterIso) && !commentIsIgnored(env.TRACKER, c.body)
  );

export const decideProgramAction = (
  program: Issue,
  comments: Comment[],
  opts: { firePending: boolean; source?: ProgramSource; runInFlight: boolean }
): ProgramAction => {
  const source = opts.source ?? "manual";
  if (opts.firePending) {
    return opts.runInFlight ? { kind: "restart", source } : { kind: "fire", source };
  }
  if (program.stateName === env.ACTIVE_STATE) {
    // ACTIVE with a live run: leave it. ACTIVE with nothing running locally: the
    // daemon restarted mid-run — resume it (worktree/scratch dir persists).
    if (opts.runInFlight) return { kind: "nothing", reason: "run in progress" };
    return { kind: "resume-interrupted" };
  }
  if (program.stateName === env.BLOCKED_STATE) {
    const lastAgent = latestAgentComment(comments);
    const replies = newUserCommentsAfter(comments, lastAgent?.createdAt);
    if (replies.length === 0) return { kind: "nothing", reason: "blocked, awaiting reply" };
    const latest = replies[replies.length - 1]!;
    // A "stop" directive abandons the run (Gene returns the program to rest); any other
    // reply (approve/redo/retry or plain prose) resumes it. Mirrors the coding resume
    // rails (parseDirective) so `!gene stop` works on programs too.
    if (parseDirective(latest.body)?.command === "stop") return { kind: "stop" };
    return { kind: "resume", latestUserCommentId: latest.id };
  }
  return { kind: "nothing", reason: "resting" };
};

// --- Child-ticket detection (observability) -----------------------------------------
export const childTicketIds = (geneIssues: Issue[], parentIdentifier: string): string[] =>
  geneIssues.filter(i => i.parentIdentifier === parentIdentifier).map(i => i.identifier);

export const newChildIdentifiers = (current: string[], alreadyLogged: string[]): string[] => {
  const seen = new Set(alreadyLogged);
  return current.filter(id => !seen.has(id));
};

// --- Detail-view section extraction -------------------------------------------------
export type ProgramSections = { trigger: string; workflow: string; acceptance: string };

const sectionBody = (desc: string, heading: string): string => {
  const text = desc || "";
  const start = text.indexOf(heading);
  if (start === -1) return "";
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n##\s/);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
};

export const extractProgramSections = (description: string): ProgramSections => ({
  trigger: sectionBody(description, "## Trigger"),
  workflow: sectionBody(description, "## Workflow"),
  acceptance: sectionBody(description, "## Acceptance criteria")
});
```

> Confirm `commentIsIgnored`'s signature in `src/ignore.ts` (used by `src/decide.ts` at `userCommentsAfter`). If it takes a different first argument than `env.TRACKER`, match `decide.ts`'s call exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/programs.test.ts`
Expected: PASS (all). Run `npm run typecheck` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/programs.ts src/programs.test.ts
git commit -m "feat(programs): decideProgramAction + fire queue + child/detail helpers"
```

---

### Task 5: Program prompt (`buildProgramPrompt` via a `buildPrompt` intent branch)

Adds the `program` intent and a repo-optional, change-request-free prompt. `buildPrompt` branches to `buildProgramPrompt` at the top; the existing coding path is guarded so `forge`/`baseBranch` become optional on the shared input type without breaking coding callers.

**Files:**
- Modify: `src/prompt.ts` (`PromptIntent` line 19; `PromptInputs` line 26; `intentInstructions` line 83; `buildPrompt` line 286)
- Test: `src/prompt.test.ts` (new)

**Interfaces:**
- Consumes: `Issue`, `Comment` (tracker); `Forge` type (from `src/prompt.ts`'s existing import); `tracker.writeBackSnippet(issue)` and `tracker.subcardSnippet(issue)` (existing tracker methods used by the current prompt/subcards); `intentInstructions`.
- Produces:
  - `PromptIntent` gains `"program"`.
  - `PromptInputs`: `forge?`, `baseBranch?`, `commitsBehind?`, `workBranch?`, `repoLabel?` become optional; adds `hasRepo?: boolean`.
  - `buildPrompt(inputs: PromptInputs): string` — returns the program prompt when `inputs.intent === "program"`; throws for coding intents missing `forge`/`baseBranch`.

- [ ] **Step 1: Write the failing test**

Create `src/prompt.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "./prompt.ts";
import type { Issue, Comment } from "./tracker/index.ts";

const program: Issue = {
  id: "id-PRG-1",
  identifier: "PRG-1",
  title: "Nightly CI triage",
  description: "## Trigger\nManual\n## Workflow\nCheck CI, retry flaky.\n## Acceptance criteria\nComment a summary.",
  stateName: "Todo",
  url: "https://example/PRG-1",
  branchName: "PRG-1",
  assigneeId: "u1",
  updatedAt: "2026-08-16T00:00:00.000Z"
};
const comments: Comment[] = [];

test("program prompt: repo-less run has no change-request instructions", () => {
  const p = buildPrompt({
    issue: program,
    comments,
    worktreePath: "/tmp/.gene/programs/PRG-1",
    intent: "program",
    attachmentRelativePaths: [],
    hasRepo: false
  });
  assert.match(p, /## Workflow/);
  assert.match(p, /## Acceptance criteria/);
  assert.match(p, /never open a change request/i);
  assert.doesNotMatch(p, /How to open the/i);
  assert.doesNotMatch(p, /git push/i);
});

test("program prompt: with a repo, still no change request but mentions the working tree", () => {
  const p = buildPrompt({
    issue: program,
    comments,
    worktreePath: "/repo/worktree",
    intent: "program",
    attachmentRelativePaths: [],
    hasRepo: true
  });
  assert.match(p, /never open a change request/i);
  assert.match(p, /working/i);
});
```

> Match the `Issue`/`Comment` factories to their real shapes. The coding-path of `buildPrompt` is already covered by the existing suite (if any); this test only pins the new `program` branch.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/prompt.test.ts`
Expected: FAIL — `"program"` is not assignable to `PromptIntent` (typecheck) / at runtime the coding path throws on missing `forge`.

- [ ] **Step 3: Implement the intent, optional fields, and the program prompt**

In `src/prompt.ts`:

1. Extend `PromptIntent` (line 19):

```ts
export type PromptIntent = "processing" | "resume" | "feedback" | "review-fix" | "continue" | "program";
```

2. Make the repo/forge fields optional on `PromptInputs` (line 26) and add `hasRepo`:

```ts
  forge?: Forge;
  baseBranch?: string;
  commitsBehind?: number;
  workBranch?: string;
  repoLabel?: string;
  /** True when the program run has a git worktree; false for a scratch dir. */
  hasRepo?: boolean;
```

3. Add the `program` entry to `intentInstructions` (line 83):

```ts
  program:
    "You are executing a recurring **program**, not a one-off coding task. Carry out the steps in the program's `## Workflow` section, then judge your result against its `## Acceptance criteria`. Investigate and act (run commands, read logs/CI/monitoring as the workflow directs). You do NOT open a change request and you do NOT push code.",
```

4. Branch at the very top of `buildPrompt` (line 286) and guard the coding path. Immediately after the function opens:

```ts
export const buildPrompt = (inputs: PromptInputs): string => {
  if (inputs.intent === "program") return buildProgramPrompt(inputs);
  const { forge, baseBranch } = inputs;
  if (!forge || baseBranch === undefined) {
    throw new Error(`buildPrompt: intent "${inputs.intent}" requires forge and baseBranch`);
  }
  // ...existing coding body unchanged (it already destructures/uses forge & baseBranch)...
```

> If the existing body re-destructures `forge`/`baseBranch` from `inputs`, remove those from the inner destructure (they're now consts above) or leave them — either way the guard narrows them to non-`undefined`. Ensure the coding body compiles against the now-optional fields (they're guaranteed present past the guard).

5. Add `buildProgramPrompt` (place it just above `buildPrompt`):

```ts
const buildProgramPrompt = (inputs: PromptInputs): string => {
  const { issue, worktreePath, hasRepo, attachmentRelativePaths } = inputs;
  const workspace = hasRepo
    ? `# Working tree\n\nYou are in a git worktree at \`${worktreePath}\`. Read and run things here, but do NOT commit, push, or open a change request — this is a program run, not a coding task.`
    : `# Working directory\n\nYou are in a scratch working directory at \`${worktreePath}\` (no git repository). Use it for any temporary files.`;

  const attachments =
    attachmentRelativePaths.length > 0
      ? `\n\n# Attachments\n\nFiles staged for you: ${attachmentRelativePaths.map(p => `\`${p}\``).join(", ")}.`
      : "";

  return [
    `# Program: ${issue.identifier} — ${issue.title}`,
    "",
    "You are Gene running a recurring **program**. The ticket below defines it. Do exactly what its `## Workflow` says and judge success by its `## Acceptance criteria`.",
    "",
    "# Program ticket",
    "",
    issue.description || "(no description)",
    "",
    workspace,
    attachments,
    "",
    "# What to do",
    "",
    intentInstructions.program,
    "",
    "# Writing back",
    "",
    tracker.writeBackSnippet(issue),
    "",
    "# Creating follow-up tickets",
    "",
    `If the workflow calls for follow-up work (e.g. "create a ticket to fix flaky tests"), create child ticket(s) so Gene picks them up later. ${tracker.subcardSnippet(issue)} Give each the \`${env.LABEL}\` label (never the program label) so it enters the normal coding queue.`,
    "",
    "# Outcomes",
    "",
    "- **Completed:** post a concise result comment on the program ticket summarising what you did and how it meets the acceptance criteria. Do not change the ticket's state — Gene restores it.",
    `- **Need a decision:** if the workflow needs a serious change or a human choice, post a comment stating exactly what you need, then move the ticket to \`${env.BLOCKED_STATE}\`. Gene will resume you when a human replies and runs \`${env.COMMAND_BASE} approve\`.`,
    "- **Plan first (optional):** if the program's `## Workflow` asks you to plan before acting, post the plan as a comment and move to " +
      `\`${env.BLOCKED_STATE}\` for approval before executing.`,
    "",
    "# Hard rules",
    "",
    "- **Never open a change request** (no PR/MR), and never `git push`.",
    "- Never move the ticket to a Done/closed state — Gene manages the program's resting state.",
    "- Stay within the program's stated workflow and tools."
  ].join("\n");
};
```

> `tracker`, `env`, and `intentInstructions` are already imported in `prompt.ts` (the coding path uses `tracker.writeBackSnippet`). Confirm `tracker.subcardSnippet(issue)` exists (it's used by `src/subcards.ts`); if the method name differs, use the exact one. If `env.COMMAND_BASE`/`env.LABEL`/`env.BLOCKED_STATE` aren't already imported, add them from `./config.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/prompt.test.ts`
Expected: PASS (2/2). Run `npm run typecheck` — expected: clean. Run the full suite `node --test 'src/**/*.test.ts'` to confirm no coding-prompt regressions.

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts src/prompt.test.ts
git commit -m "feat(programs): buildProgramPrompt + program intent (repo-optional, no CR)"
```

---

### Task 6: Repo-optional agent spawn

Lets `invokeAgent` run without a forge (repo-less program) and grant program-specific extra tools. Extracts the allowed-tools composition into a pure, tested helper.

**Files:**
- Modify: `src/invoke.ts` (`InvokeInputs` line ~98; the destructure at line ~520; the allowed-tools assembly at lines ~522-523)
- Test: `src/invoke.test.ts` (new)

**Interfaces:**
- Consumes: `BASE_ALLOWED_TOOLS`, `tracker.allowedTools()`, `forge.allowedTools()`, `env.ALLOWED_TOOLS`, `env.PROGRAM_ALLOWED_TOOLS`.
- Produces:
  - `InvokeInputs.forge?: Forge` (optional) and `InvokeInputs.extraAllowedTools?: string[]`.
  - `composeAllowedTools(parts: { base: string[]; tracker: string[]; forge?: string[]; global?: string[]; extra?: string[] }): string[]`

- [ ] **Step 1: Write the failing test**

Create `src/invoke.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeAllowedTools } from "./invoke.ts";

test("composeAllowedTools includes forge tools when a forge is present", () => {
  const out = composeAllowedTools({
    base: ["Bash(git *)"],
    tracker: ["Bash(linear *)"],
    forge: ["Bash(gh *)"],
    global: ["Bash(curl *)"],
    extra: ["Bash(pup *)"]
  });
  assert.deepEqual(out, ["Bash(git *)", "Bash(linear *)", "Bash(gh *)", "Bash(curl *)", "Bash(pup *)"]);
});

test("composeAllowedTools omits forge tools when there is no forge (repo-less program)", () => {
  const out = composeAllowedTools({
    base: ["Bash(git *)"],
    tracker: ["Bash(linear *)"],
    extra: ["Bash(pup *)"]
  });
  assert.deepEqual(out, ["Bash(git *)", "Bash(linear *)", "Bash(pup *)"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/invoke.test.ts`
Expected: FAIL — no export `composeAllowedTools`.

- [ ] **Step 3: Implement the helper + optional forge**

In `src/invoke.ts`, add the exported helper (near `BASE_ALLOWED_TOOLS`, line ~40):

```ts
/** Assemble the agent's allowed-tools list. Forge tools are included only when the
 *  run has a forge (a repo-less program run has none). Order: base, tracker, forge,
 *  global (env.ALLOWED_TOOLS), extra (program tools). */
export const composeAllowedTools = (parts: {
  base: string[];
  tracker: string[];
  forge?: string[];
  global?: string[];
  extra?: string[];
}): string[] => [
  ...parts.base,
  ...parts.tracker,
  ...(parts.forge ?? []),
  ...(parts.global ?? []),
  ...(parts.extra ?? [])
];
```

Make `forge` optional and add `extraAllowedTools` on `InvokeInputs` (line ~98):

```ts
  forge?: Forge;
  extraAllowedTools?: string[];
```

Update the destructure (line ~520) and the allowed-tools assembly (lines ~522-523). Replace:

```ts
const { issue, prompt, worktreePath, forge } = inputs;
const allowedTools = [...BASE_ALLOWED_TOOLS, ...tracker.allowedTools(), ...forge.allowedTools()];
allowedTools.push(...env.ALLOWED_TOOLS);
```

with:

```ts
const { issue, prompt, worktreePath, forge } = inputs;
const allowedTools = composeAllowedTools({
  base: BASE_ALLOWED_TOOLS,
  tracker: tracker.allowedTools(),
  forge: forge ? forge.allowedTools() : undefined,
  global: env.ALLOWED_TOOLS,
  extra: inputs.extraAllowedTools
});
```

> Then scan the rest of `invokeAgent` for other uses of `forge` (e.g. building `getAgentArgs`, logging, or a forge-specific env) and guard each with `forge ? ... : ...`. The coding caller always passes a forge, so behaviour there is unchanged; only the program (no-forge) path must not dereference `forge`. Confirm `getAgentArgs` (line ~301) is not passed anything forge-derived that would break when absent.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/invoke.test.ts`
Expected: PASS (2/2). Run `npm run typecheck` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/invoke.ts src/invoke.test.ts
git commit -m "feat(programs): repo-optional invoke (optional forge + extra tools)"
```

---

### Task 7: Monitor + theme — resting program rows, ⟳ glyph, `idle` status

The dashboard renders from `snapshot.agents`, so a program must be a monitor row to be visible and selectable at rest. Adds an `isProgram` flag, an `idle` status for a resting program, a `setProgramRow` upsert the daemon calls each scan, and the ⟳ glyph in the theme.

**Files:**
- Modify: `src/monitor.ts` (`AgentState` line ~79; `AgentStatus`/status lists; `agentDispatched` neighbourhood ~343; add `setProgramRow`)
- Modify: `src/ui/theme.ts` (add `PROGRAM_GLYPH` + `idle` status glyph/color/label)
- Test: `src/monitor.test.ts` (extend); `src/ui/theme.test.ts` (new, if none exists)

**Interfaces:**
- Consumes: existing `AgentState`/`AgentStatus` in `src/monitor.ts`.
- Produces:
  - `AgentState.isProgram?: boolean`; `AgentState.lifecycleState?: string` (the tracker state to show for a program row); `AgentState.description?: string` (the program ticket body, for the detail view's sections).
  - `AgentStatus` gains `"idle"`.
  - `monitor.setProgramRow(id: string, title: string, state: string, description?: string): void` — upserts a program row (creates it `idle` if absent; marks `isProgram` + `stage="program"` if present; stores `description`; never downgrades a live run's status).
  - `PROGRAM_GLYPH = "⟳"` in theme; theme status helpers handle `"idle"`.

- [ ] **Step 1: Write the failing tests**

Extend `src/monitor.test.ts` (it imports the `monitor` singleton and reads state via `monitor.getState()`, which returns `{ daemon, agents, tokens }` — monitor.ts:470):

```ts
test("setProgramRow creates an idle, program-flagged row", () => {
  monitor.setProgramRow("PRG-1", "Nightly triage", "Todo");
  const row = monitor.getState().agents.find(a => a.id === "PRG-1");
  assert.ok(row);
  assert.equal(row!.isProgram, true);
  assert.equal(row!.stage, "program");
  assert.equal(row!.status, "idle");
  assert.equal(row!.lifecycleState, "Todo");
});

test("setProgramRow does not downgrade a running program to idle", () => {
  monitor.agentDispatched("PRG-2", "program", "(no repo)", undefined, "Running one");
  monitor.agentSpawned("PRG-2", 12345, () => {}); // flips the row to "running" (monitor.ts:400)
  monitor.setProgramRow("PRG-2", "Running one", "In Progress");
  const row = monitor.getState().agents.find(a => a.id === "PRG-2");
  assert.ok(row);
  assert.equal(row!.isProgram, true);
  assert.notEqual(row!.status, "idle"); // stays running, not reset to idle
});
```

> `node --test` runs each file in its own process, so the `monitor` singleton starts empty — pick program ids (`PRG-1`/`PRG-2`) that won't collide with the file's existing token tests. `agentSpawned(id, pid, cancel)` is the real running transition (monitor.ts:400).

Create `src/ui/theme.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROGRAM_GLYPH } from "./theme.ts";

test("program glyph is the recycle symbol", () => {
  assert.equal(PROGRAM_GLYPH, "⟳");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/monitor.test.ts src/ui/theme.test.ts`
Expected: FAIL — `setProgramRow`/`isProgram`/`PROGRAM_GLYPH` undefined.

- [ ] **Step 3: Implement**

In `src/monitor.ts`:

1. Add `"idle"` to the `AgentStatus` union (monitor.ts:57) and to the `AgentStatuses` array (monitor.ts:58):

```ts
export type AgentStatus = "queued" | "running" | "done" | "error" | "timeout" | "cancelled" | "blocked" | "interrupted" | "idle";
export const AgentStatuses: AgentStatus[] = ["queued", "running", "done", "error", "timeout", "cancelled", "blocked", "interrupted", "idle"];
```

Then handle `"idle"` everywhere the compiler flags a non-exhaustive `switch` over `AgentStatus`, and in any running-count / terminal-status predicate treat `idle` as NOT running (a resting program must not consume a concurrency slot). Run `npm run typecheck` to enumerate the switch sites.

2. Add fields to `AgentState` (line ~79):

```ts
  isProgram?: boolean;
  lifecycleState?: string;
  description?: string;
```

3. Add the upsert method (near `agentDispatched`, ~343) — match the class/singleton style of the file (field access, change notification):

```ts
  setProgramRow(id: string, title: string, state: string, description?: string): void {
    const existing = this.agents.get(id);
    if (!existing) {
      this.agents.set(id, {
        id,
        title,
        stage: "program",
        status: "idle",
        isProgram: true,
        lifecycleState: state,
        description,
        // ...fill remaining REQUIRED AgentState fields with the SAME literals a fresh
        //    row gets in agentDispatched — read that method and copy them verbatim
        //    (e.g. events: [], toolCount: 0, and any others it sets).
      });
    } else {
      existing.isProgram = true;
      existing.stage = "program";
      if (title) existing.title = title;
      existing.lifecycleState = state;
      if (description !== undefined) existing.description = description;
    }
    this.emitChange(); // use the real change-notify call this file uses
  }
```

> Read `agentDispatched` to copy the exact set of required `AgentState` fields for a fresh row and the real change-notification method name (`emitChange`/`scheduleChange`/etc.). Do NOT reset status on an existing row — that's what keeps a running/finished program from flipping back to `idle`.

In `src/ui/theme.ts`:

```ts
export const PROGRAM_GLYPH = "⟳";
```

Add an `idle` case wherever the theme maps status → glyph/color/label (mirror the existing `queued` case): a subdued glyph (e.g. `"·"`), a dim color, and label `"idle"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/monitor.test.ts src/ui/theme.test.ts`
Expected: PASS. Run `npm run typecheck` — expected: clean (the new `AgentStatus` member must be handled everywhere the compiler flags an exhaustive switch).

- [ ] **Step 5: Commit**

```bash
git add src/monitor.ts src/ui/theme.ts src/monitor.test.ts src/ui/theme.test.ts
git commit -m "feat(programs): monitor program rows + idle status + ⟳ glyph"
```

---

### Task 8: Lifecycle wiring — `dispatchProgram`, `scanPrograms`, `finishProgramRun`, poll loop, fire callback

The impure integration: fetch programs each poll, decide per program, dispatch under `withLock`, restore the resting state on finish (never Done; skip on Blocked/cancelled), detect child tickets, emit observability events, register rows for the TUI, and expose `fireProgram` through `startUi`. Verified by typecheck + a smoke run (integration glue; its decision/state/tools pieces are unit-tested in Tasks 3/4/6).

**Files:**
- Modify: `src/index.ts` (imports; add `findProgram`, `prepareProgramWorkspace`, `dispatchProgram`, `finishProgramRun`, `scanPrograms`; wire into `runForever` ~918-980; add `fireProgram` to the `startUi(...)` options ~1187-1242)
- Modify: `src/db.ts` — ensure `readIssueLog` is exported (used for child-ticket dedupe); if it doesn't exist, use the existing log-reading function.

**Interfaces:**
- Consumes: `decideProgramAction`, `fireProgram`, `hasFireRequest`, `takeFireRequest`, `childTicketIds`, `newChildIdentifiers` (Task 4); `readProgramState`, `writeProgramState`, `safeRestingState` (Task 3); `buildPrompt` with `intent:"program"` (Task 5); `invokeAgent` with optional forge + `extraAllowedTools` (Task 6); `monitor.setProgramRow`, `monitor.isCancelled`, `monitor.requestCancel`, `monitor.agentDispatched`, `monitor.agentSettled`, `monitor.getAgent` (Task 7 + existing); existing `resolveTarget`, `targetLabel`, `selectForge`, `ensureWorktree`, `stageIssueAttachments`, `withLock`, `record`, `postStartComment`, `buildClarificationComment`, `findMissingSections` (Task 1), `dispatchPluginEvent`, `inFlight`, `isAtConcurrencyCap` (or the existing cap check), `logger`, `GENE_DIR`.
- Produces: internal `dispatchProgram`/`scanPrograms`/`finishProgramRun`/`findProgram`; a `fireProgram` entry in `StartUiOptions` (consumed by Task 9).

- [ ] **Step 1: Add imports and helpers**

In `src/index.ts`, add to imports:

```ts
import {
  decideProgramAction,
  fireProgram,
  hasFireRequest,
  takeFireRequest,
  childTicketIds,
  newChildIdentifiers,
  type ProgramSource
} from "./programs.ts";
import { readProgramState, writeProgramState, safeRestingState } from "./program-state.ts";
import { findMissingSections } from "./decide.ts";
import { GENE_DIR } from "./config.ts";
import { mkdir } from "node:fs/promises";
```

> `excludePrograms` is already imported (Task 2). `path` and `env` are already imported. Confirm `readIssueLog` (or the equivalent log reader) and `buildClarificationComment` names from their definitions.

Add `findProgram` (near the existing `findIssue`):

```ts
const findProgram = async (identifier: string): Promise<Issue | undefined> => {
  const programs = await tracker.listPrograms(env.PROGRAM_LABEL);
  return programs.find(p => p.identifier.toLowerCase() === identifier.toLowerCase());
};
```

Add the workspace helper:

```ts
const prepareProgramWorkspace = async (
  program: Issue,
  target: RepoTarget | undefined,
  forge: Forge | undefined
): Promise<{ worktreePath: string; hasRepo: boolean }> => {
  if (target && forge) {
    const { worktreePath } = await ensureWorktree(target, program, forge);
    return { worktreePath, hasRepo: true };
  }
  const scratch = path.join(GENE_DIR, "programs", program.identifier);
  await mkdir(scratch, { recursive: true });
  return { worktreePath: scratch, hasRepo: false };
};
```

> Confirm `ensureWorktree`'s exact signature/return (it's imported from `invoke.ts`); `dispatchAgent` calls it — mirror that call precisely (it may take different args / return more than `worktreePath`).

- [ ] **Step 2: Add `finishProgramRun`**

```ts
const finishProgramRun = async (program: Issue, result: InvokeResult): Promise<void> => {
  // Cancelled (a restart or a UI cancel): leave the ticket ACTIVE so the re-fire /
  // next scan picks it up; don't restore or clobber state.
  if (monitor.isCancelled(program.identifier)) {
    await record(program, "program-run-done", "cancelled", { last_result: "cancelled" });
    return;
  }
  // The agent may have parked the program in Blocked awaiting a decision — honour it.
  let current: Issue | undefined;
  try {
    current = await findProgram(program.identifier);
  } catch {
    current = undefined;
  }
  if (current && current.stateName === env.BLOCKED_STATE) {
    logger.info(`${logger.tag.flow} [${program.identifier}] parked in ${env.BLOCKED_STATE} — awaiting reply`);
    await record(program, "program-run-done", `parked in ${env.BLOCKED_STATE}`, { last_result: "blocked" });
    return;
  }

  const state = await readProgramState(tracker.name, program.identifier);
  const resting = safeRestingState(state?.restingState, env.DONE_STATE, env.TRIGGER_STATE);
  try {
    await tracker.moveToState(program, resting);
  } catch (error) {
    logger.warn(
      `${logger.tag.flow} [${program.identifier}] could not restore to "${resting}":`,
      error instanceof Error ? error.message : error
    );
  }

  const ok = result.exitCode === 0 && result.sawSuccessResult && !result.transientFailure;
  const lastResult = ok ? "ok" : "incomplete";
  await writeProgramState(tracker.name, program.identifier, {
    lastResult,
    lastFiredAt: new Date().toISOString()
  });

  // Child-ticket detection (best-effort observability): log Gene-labelled children of
  // this program that weren't logged before.
  try {
    const gene = await tracker.listIssues();
    const children = childTicketIds(gene, program.identifier);
    const priorLog = await readIssueLog(tracker.name, program.identifier);
    const loggedChildren = priorLog
      .filter(r => r.event === "child-ticket-created" && r.data && typeof r.data === "object" && "identifier" in r.data)
      .map(r => String((r.data as { identifier: unknown }).identifier));
    for (const id of newChildIdentifiers(children, loggedChildren)) {
      await record(program, "child-ticket-created", id, { identifier: id });
    }
  } catch (error) {
    logger.warn(
      `${logger.tag.flow} [${program.identifier}] child-ticket detection failed:`,
      error instanceof Error ? error.message : error
    );
  }

  await record(program, "program-run-done", `→ ${resting} (${lastResult})`, { last_result: lastResult });
};
```

> Confirm `InvokeResult`'s fields (`exitCode`, `sawSuccessResult`, `transientFailure`) against `src/invoke.ts` — `dispatchAgent`'s stalled-check reads the same fields, so copy that predicate's shape exactly. Confirm `record(issue, event, detail, data?)`'s signature and `readIssueLog`'s row shape (`{ event, data }`) from `src/db.ts`.

- [ ] **Step 3: Add `dispatchProgram`**

```ts
const dispatchProgram = async (
  program: Issue,
  comments: Comment[],
  opts: { source: ProgramSource; recordResting: boolean }
): Promise<void> => {
  if (inFlight.has(program.id)) {
    logger.info(`${logger.tag.flow} [${program.identifier}] program already running — skipping`);
    return;
  }

  // Section gate (fire time only — a resume/interrupted continuation skips it).
  if (opts.recordResting && env.PROGRAM_REQUIRE_SECTIONS.length > 0) {
    const missing = findMissingSections(program.description, env.PROGRAM_REQUIRE_SECTIONS);
    if (missing.length > 0) {
      logger.warn(`${logger.tag.flow} [${program.identifier}] missing sections: ${missing.join(", ")} — not firing`);
      try {
        await tracker.postComment(program, buildClarificationComment(missing));
      } catch {
        /* best effort */
      }
      return;
    }
  }

  const target = resolveTarget(program, comments);
  const forge = target ? selectForge(target.forge) : undefined;
  const repoLabel = target ? targetLabel(target) : "(no repo)";

  monitor.agentDispatched(program.identifier, "program", repoLabel, undefined, program.title);
  void dispatchPluginEvent({ kind: "agent-started", issue: program, intent: "program" });

  if (isAtConcurrencyCap()) {
    logger.info(`${logger.tag.flow} [${program.identifier}] at concurrency cap — deferring`);
    if (opts.recordResting) fireProgram(program.identifier, opts.source); // re-enqueue, don't lose the fire
    monitor.agentSettled(program.identifier);
    return;
  }

  if (opts.recordResting) {
    await writeProgramState(tracker.name, program.identifier, {
      restingState: program.stateName,
      lastFiredAt: new Date().toISOString(),
      lastSource: opts.source
    });
    await record(program, "program-fired", `source: ${opts.source} (resting: ${program.stateName})`, {
      source: opts.source
    });
  }
  await record(program, "dispatch", `program → ${repoLabel} [${forge ? forge.name : "none"}] ⎇ (program run)`, {
    title: program.title
  });

  if (env.DRY_RUN) {
    await postStartComment(program, "program");
    await tracker.moveToState(program, env.ACTIVE_STATE);
    logger.info(`${logger.tag.flow} [${program.identifier}] (dry-run) would run program in ${repoLabel}`);
    monitor.agentSettled(program.identifier);
    return;
  }

  const spawnPromise = withLock(program.identifier, async () => {
    await postStartComment(program, "program");
    await tracker.moveToState(program, env.ACTIVE_STATE);
    const { worktreePath, hasRepo } = await prepareProgramWorkspace(program, target, forge);

    let attachmentRelativePaths: string[] = [];
    try {
      const staged = await stageIssueAttachments(program, comments, worktreePath);
      attachmentRelativePaths = staged.map(s => s.relativePath);
    } catch (error) {
      logger.warn(
        `${logger.tag.flow} [${program.identifier}] attachment staging failed:`,
        error instanceof Error ? error.message : error
      );
    }

    const prompt = buildPrompt({
      issue: program,
      comments,
      worktreePath,
      intent: "program",
      attachmentRelativePaths,
      hasRepo,
      forge,
      repoLabel,
      subdir: target?.subdir
    });

    const result = await invokeAgent(
      { issue: program, prompt, worktreePath, forge, extraAllowedTools: env.PROGRAM_ALLOWED_TOOLS },
      (pid: number) => {
        inFlight.set(program.id, { ...inFlight.get(program.id), pid });
      }
    );
    await finishProgramRun(program, result);
    return result;
  })
    .then(result => {
      if (result === "skipped") {
        logger.info(`${logger.tag.flow} [${program.identifier}] another run holds the lock — skipping`);
      }
    })
    .catch(error => {
      logger.error(
        `${logger.tag.flow} [${program.identifier}] program spawn failed:`,
        error instanceof Error ? error.message : error
      );
    })
    .finally(() => {
      inFlight.delete(program.id);
      monitor.agentSettled(program.identifier);
      void dispatchPluginEvent({
        kind: "agent-finished",
        issue: program,
        status: monitor.getAgent(program.identifier)?.status ?? "done"
      });
    });

  inFlight.set(program.id, {
    ...inFlight.get(program.id),
    promise: spawnPromise,
    startedAt: Date.now(),
    identifier: program.identifier
  });
};
```

> Mirror `dispatchAgent` (lines ~401-554) closely for: the concurrency-cap check (`isAtConcurrencyCap()` — use the real predicate the file uses), the `inFlight` record shape (copy its exact field set: `promise`, `startedAt`, `identifier`, `pid`, plus any others), the `withLock` return-value handling, and the `.finally` plugin/monitor calls. `stageIssueAttachments`'s return shape (`{ relativePath }[]`) must match its definition. `postStartComment(program, "program")` needs the `"program"` key added to `startMessages` — see Step 4.

- [ ] **Step 4: Add the `program` start message**

In `src/index.ts`, add a `"program"` entry to `startMessages: Record<PromptIntent, string>` (line ~95):

```ts
  program: "🧬 running this program now — I'll comment when it's done or if I need a decision.",
```

- [ ] **Step 5: Add `scanPrograms`**

```ts
const scanPrograms = async (programs: Issue[]): Promise<void> => {
  for (const program of programs) {
    if (!tracker.isAssignedToOwner(program)) continue;
    monitor.setProgramRow(program.identifier, program.title, program.stateName, program.description);

    const runInFlight = inFlight.has(program.id);
    const source = hasFireRequest(program.identifier) ? takeFireRequest(program.identifier) : undefined;
    const comments = source !== undefined || program.stateName === env.BLOCKED_STATE || program.stateName === env.ACTIVE_STATE
      ? await tracker.getComments(program)
      : [];

    const action = decideProgramAction(program, comments, {
      firePending: source !== undefined,
      source,
      runInFlight
    });
    if (action.kind !== "nothing") {
      logger.info(`${logger.tag.flow} [${program.identifier}] program → ${action.kind}`);
    }

    switch (action.kind) {
      case "nothing":
        break;
      case "fire":
        await dispatchProgram(program, comments, { source: action.source, recordResting: true });
        break;
      case "restart":
        // Cancel the live run; re-enqueue so the next scan fires once the lock frees.
        monitor.requestCancel(program.identifier);
        fireProgram(program.identifier, action.source);
        break;
      case "resume":
      case "resume-interrupted":
        await dispatchProgram(program, comments, { source: "manual", recordResting: false });
        break;
      case "stop": {
        // User replied `!gene stop` on a Blocked program: abandon it, return to rest.
        const st = await readProgramState(tracker.name, program.identifier);
        const resting = safeRestingState(st?.restingState, env.DONE_STATE, env.TRIGGER_STATE);
        try {
          await tracker.moveToState(program, resting);
        } catch (error) {
          logger.warn(
            `${logger.tag.flow} [${program.identifier}] could not stop → "${resting}":`,
            error instanceof Error ? error.message : error
          );
        }
        await record(program, "program-run-done", `stopped → ${resting}`, { last_result: "stopped" });
        break;
      }
    }
  }
};
```

> `isAssignedToOwner` and `getComments` are the same tracker methods `scanOnce` uses — match their names. Fetching comments only when needed keeps the resting-program poll cheap.

- [ ] **Step 6: Wire into `runForever`**

In `runForever` (line ~918), replace the `scanOnce(issueFilter)` call in the loop body (line ~946) with a program-aware cycle:

```ts
let programs: Issue[] = [];
try {
  programs = await tracker.listPrograms(env.PROGRAM_LABEL);
} catch (error) {
  logger.warn(
    `${logger.tag.flow} could not list programs:`,
    error instanceof Error ? error.message : error
  );
}
await scanPrograms(programs);
const found = await scanOnce(issueFilter, new Set(programs.map(p => p.identifier)));
```

> Keep the existing use of `found` (the `--once` found/not-found behaviour) unchanged. The `wakePoll` wiring (lines ~967-980) already re-runs this loop body, so a UI fire that calls `requestScan` triggers a fresh program scan.

- [ ] **Step 7: Expose `fireProgram` through `startUi`**

Add to the `StartUiOptions` object passed to `startUi(...)` (lines ~1187-1242):

```ts
    fireProgram: (identifier: string) => {
      fireProgram(identifier);
      setPaused(false); // a manual fire is explicit intent — never swallowed by pause
      requestScan();
    },
```

> `fireProgram` here refers to the import from `./programs.ts`; the object key is just a property name (no shadowing). `setPaused`/`requestScan` are the same callbacks already defined in this options object — reuse them.

- [ ] **Step 8: Typecheck + smoke test**

Run: `npm run typecheck` — expected: clean.

Build and smoke-test (strip-only means typecheck ≠ runs):

```bash
npm run build
node --experimental-ffi --disable-warning=ExperimentalWarning --env-file-if-exists=.env.development src/index.ts --once
```

Expected: the daemon starts, lists programs without throwing, runs one scan cycle, and exits (`--once`). With `GENE_DRY_RUN=true` set and a `Program`-labelled ticket present, confirm the log shows a program scan and (if fired) a dry-run dispatch line — no change-request activity. Do NOT commit real runs; use dry-run for the smoke.

- [ ] **Step 9: Commit**

```bash
git add src/index.ts src/db.ts
git commit -m "feat(programs): scanPrograms + dispatchProgram lifecycle + fire plumbing"
```

---

### Task 9: TUI surfacing — ⟳ marker, programs filter, `g` fire/restart, detail sections + history

Renders program rows with ⟳, adds a programs-only filter toggle, fires/restarts the selected program via `g` (arm→confirm), and shows the program's sections + run history in the detail view.

**Files:**
- Modify: `src/ui/dashboard.ts` (⟳ marker on program rows; programs filter; pure `filterAgents`)
- Modify: `src/ui/app.ts` (`StartUiOptions` +`fireProgram`; `g` arm→confirm handler; footer hint; wire `getProgramDetail` if used)
- Modify: `src/ui/detail.ts` (render `## Trigger`/`## Workflow`/`## Acceptance criteria` + run history for program rows)
- Modify: `src/ui/header.ts` (optional programs count)
- Test: `src/ui/dashboard.test.ts` (new — pure `filterAgents`)

**Interfaces:**
- Consumes: `PROGRAM_GLYPH`, `AgentState.isProgram` (Task 7); `options.fireProgram` (Task 8); `extractProgramSections` (Task 4); `snapshot.agents`, `dashboard.getOrderedIds()`, `showToast`, `palette` (existing app.ts).
- Produces:
  - `StartUiOptions.fireProgram: (identifier: string) => void`
  - `filterAgents(agents: AgentState[], opts: { onlyPrograms: boolean }): AgentState[]` (pure, in dashboard.ts)

- [ ] **Step 1: Write the failing test**

Create `src/ui/dashboard.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterAgents } from "./dashboard.ts";
import type { AgentState } from "../monitor.ts";

const agent = (id: string, isProgram: boolean): AgentState =>
  ({ id, title: id, stage: isProgram ? "program" : "processing", status: "running", isProgram, events: [], toolCount: 0 } as AgentState);

test("filterAgents onlyPrograms keeps only program rows", () => {
  const rows = [agent("PRG-1", true), agent("ENG-2", false), agent("PRG-3", true)];
  assert.deepEqual(filterAgents(rows, { onlyPrograms: true }).map(a => a.id), ["PRG-1", "PRG-3"]);
});

test("filterAgents without the filter returns everything", () => {
  const rows = [agent("PRG-1", true), agent("ENG-2", false)];
  assert.deepEqual(filterAgents(rows, { onlyPrograms: false }).map(a => a.id), ["PRG-1", "ENG-2"]);
});
```

> Match the `AgentState` factory to its real required fields (Task 7 added `isProgram`); the cast `as AgentState` covers any extra required fields for the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/ui/dashboard.test.ts`
Expected: FAIL — no export `filterAgents`.

- [ ] **Step 3: Implement the dashboard filter + marker**

In `src/ui/dashboard.ts`, add the pure helper and use it where the row list is computed:

```ts
export const filterAgents = (agents: AgentState[], opts: { onlyPrograms: boolean }): AgentState[] =>
  opts.onlyPrograms ? agents.filter(a => a.isProgram) : agents;
```

Where a row's leading marker/prefix is rendered, prepend `PROGRAM_GLYPH` (import it from `./theme.ts`) when `agent.isProgram`, e.g.:

```ts
const marker = agent.isProgram ? `${PROGRAM_GLYPH} ` : "";
```

Add a `showOnlyPrograms` boolean to the dashboard's render state and apply `filterAgents(agents, { onlyPrograms: showOnlyPrograms })` before rows are laid out. Expose a toggle method (e.g. `dashboard.toggleProgramsFilter()`).

> Follow the existing hide-Done filter pattern in dashboard.ts (there's already a `hideDone` toggle wired to `d` in app.ts) — mirror it exactly for `onlyPrograms`.

- [ ] **Step 4: Implement the `g` fire/restart handler in app.ts**

Add `fireProgram` to `StartUiOptions` (app.ts lines ~38-75):

```ts
  fireProgram: (identifier: string) => void;
```

Add arm state near the other arm fields (`fireArmedId: string | null`, `fireArmedAt: number`), expire it in `paint()` alongside the other 2s arms (lines ~288-305), and add the handler:

```ts
const armFireProgram = (): void => {
  const ids = dashboard.getOrderedIds();
  if (selectedIndex < 0 || selectedIndex >= ids.length) return;
  const id = ids[selectedIndex]!;
  // Look the row up in the SAME merged set the dashboard renders (live agents +
  // history seed), since getOrderedIds() is built from that — snapshot.agents alone
  // would miss a program row reconstructed from the log before the first scan.
  const agent = mergeAgents(snapshot.agents, historySeed).find(a => a.id === id);
  if (!agent || !agent.isProgram) {
    showToast(`${id} is not a program`, palette.warn);
    return;
  }
  const running = agent.status === "running" || agent.status === "queued";
  const now = Date.now();
  if (fireArmedId === id && now - fireArmedAt <= 2000) {
    fireArmedId = null;
    options.fireProgram(id);
    showToast(running ? `⟳ restarting ${id}` : `⟳ firing ${id}`, palette.info);
  } else {
    fireArmedId = id;
    fireArmedAt = now;
    showToast(running ? `press g again to RESTART ${id}` : `press g again to fire ${id}`, palette.warn);
  }
};
```

Add `case "g": armFireProgram(); paint(); return;` to the **dashboard** keypress switch (lines ~745-823, next to `case "s"`/`case "d"`), and add a `g fire` hint to the footer/help text. Add the programs-filter toggle key too (e.g. reuse an unused key — check the existing bindings first; the spec calls it a "programs filter toggle") calling `dashboard.toggleProgramsFilter(); paint();`.

> `snapshot`, `mergeAgents`, and `historySeed` are the existing closure vars in app.ts (see the merge at app.ts:316). Match `palette.info`/`palette.warn` to the real palette keys used by the neighbouring `showToast` calls (grep app.ts for `showToast(` to see which keys exist). Mirror `armRemove`/`doRemove` (lines ~563-600) for the arm→confirm structure and the paint()-expiry of `fireArmedId`/`fireArmedAt`.

- [ ] **Step 5: Detail view — sections + history**

The program body reaches the UI on `AgentState.description` (set by `setProgramRow` in Task 7, populated by `scanPrograms` in Task 8) — no new async UI callback needed.

In `src/ui/detail.ts`, when the opened row `isProgram`, render the three sections above the existing run-history block:

```ts
import { extractProgramSections } from "../programs.ts";
// ...inside the detail render, when `agent.isProgram`:
const s = extractProgramSections(agent.description ?? "");
// render three labelled blocks: "Trigger" → s.trigger, "Workflow" → s.workflow,
// "Acceptance criteria" → s.acceptance, each falling back to a dim "(none)" when empty,
// using the same text/box primitives the detail view already uses for the description.
```

Run history already renders from `readIssueLog`; the program events (`program-fired`, `program-run-done`, `child-ticket-created`) appear there automatically once Task 8 records them.

> Match the exact opentui render primitives detail.ts already uses (it currently renders the issue description + the log). Do not introduce a new layout system — reuse the existing section/box helpers.

- [ ] **Step 6: Header count (optional)**

In `src/ui/header.ts`, if the header shows per-category counts, add a programs count = `agents.filter(a => a.isProgram).length` with the ⟳ glyph. Keep it consistent with the existing count rendering; skip if the header has no count row.

- [ ] **Step 7: Run tests + smoke**

Run: `node --test src/ui/dashboard.test.ts` — expected: PASS. Run `npm run typecheck` — expected: clean. Then:

```bash
npm run build
GENE_DRY_RUN=true node --experimental-ffi --disable-warning=ExperimentalWarning --env-file-if-exists=.env.development src/index.ts
```

Expected (with a `Program`-labelled ticket assigned to the owner): the dashboard shows the program row marked ⟳ with `idle` status; the programs-filter toggle hides non-program rows; selecting it and pressing `g` twice fires it (dry-run: a dispatch log line, ticket→ACTIVE, no CR); the detail view shows the three sections + run history. Quit with the existing key.

- [ ] **Step 8: Commit**

```bash
git add src/ui/dashboard.ts src/ui/app.ts src/ui/detail.ts src/ui/header.ts src/ui/dashboard.test.ts
git commit -m "feat(programs): TUI ⟳ marker, programs filter, g fire/restart, detail sections"
```

---

### Task 10: Documentation

Documents the three config keys, the program-ticket format, and the `g` fire/restart + programs-filter TUI controls.

**Files:**
- Modify: `README.md` (a "Programs" subsection)
- Modify: `.gene.config.example` (the three `PROGRAM_*` keys, commented)
- Modify: `.env.example` (the three keys)

> Do NOT edit `.env.development` (user-owned).

- [ ] **Step 1: Document config keys**

In `.gene.config.example` and `.env.example`, add (adjust the prefix note to match how the file documents `LINEAR_LABEL`/`TRELLO_LABEL`):

```
# Programs mode — a ticket labelled with the program label runs on demand (fire from
# the TUI with `g`) instead of producing a change request. Sections: ## Trigger,
# ## Workflow, ## Acceptance criteria.
# LINEAR_PROGRAM_LABEL=Program        # (or TRELLO_PROGRAM_LABEL) tracker-namespaced, default "Program"
# GENE_PROGRAM_REQUIRE_SECTIONS=## Trigger,## Workflow,## Acceptance criteria
# GENE_PROGRAM_ALLOWED_TOOLS=          # extra tools for program agents, e.g. Bash(pup *),Bash(datadog *)
```

- [ ] **Step 2: Document the feature in README**

Add a "Programs" subsection to `README.md` describing: what a program is (a `Program`-labelled ticket with the three sections), that it runs on demand and writes back to the ticket (never a change request), the resting-state restore (never Done), the clarification→Blocked→`!gene approve` resume loop, and the TUI controls (⟳ marker, `g` to fire/restart with confirm, the programs-filter toggle, detail view sections + run history). Mention that triggers (auto-firing from CI/monitoring signals) are a later phase.

- [ ] **Step 3: Verify + commit**

Run `npm run typecheck` and the full suite `node --test 'src/**/*.test.ts'` one last time — expected: clean, all green.

```bash
git add README.md .gene.config.example .env.example
git commit -m "docs(programs): document PROGRAM_* config + programs-mode TUI controls"
```

---

## Notes for the executor

- **Lock model:** the per-issue file lock (`withLock`) is the ONLY mutual-exclusion mechanism. `program_state` and `issue_log` are status/observability, never a lock. Do not add a DB-status lock.
- **Restart semantics:** `restart` cancels the live run and re-enqueues a fire; `finishProgramRun` sees `monitor.isCancelled` and skips the restore, so the ticket stays ACTIVE and the next scan fires cleanly (no resting-state flip). The cancelled run's partial write-back stays — accepted.
- **Never-Done invariant:** enforced in `safeRestingState` (unit-tested) and applied in `finishProgramRun`. The program prompt also forbids the agent from moving to Done.
- **Repo-optional:** `resolveTarget` returning nothing is normal for a program — it runs in `.gene/programs/<id>` with no forge and no forge CLIs. Never dereference `forge` on the program path without a guard.
- **Phase 2 (out of scope here):** triggers (Linear CI-failure checks, DataDog/PUP 500-error checks) that enqueue via `fireProgram(id, "trigger")`; the queue and `source` plumbing are already in place for them.
