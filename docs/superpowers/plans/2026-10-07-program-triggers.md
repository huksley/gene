# Program Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire programs automatically from their free-form `## Trigger` prose, compiled once by an agent into a JS check that runs in a QuickJS sandbox on the poll loop.

**Architecture:** A new `src/trigger/` module: `sandbox.ts` (QuickJS + `gene` API, host fns injected), `host.ts` (real cron/fetch/exec + allowlist), `schedule.ts` (pure gates/intervals), `compile.ts` (prose → code via `claude -p`, validate, retry), `store.ts` (`program_trigger` table), `index.ts` (scanner with injected daemon hooks). `src/index.ts` `scanPrograms` calls the scanner before its decision loop; a fire goes through the existing `fireProgram` queue, now carrying a `reason` into the program prompt. TUI shows ⚡ and a status line.

**Tech Stack:** Node 26 + TypeScript run directly (`node --test`), `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync` 0.32, `cron-parser` 5, PGlite/pg store, OpenTUI.

**Spec:** `docs/superpowers/specs/2026-10-07-program-triggers-design.md`

## Amendment A (2026-10-07, before execution) — real trial run + exec problem detection

Overrides the named parts of Tasks 4, 6 and 7; everything else stands.

- **Task 4** adds `execProblem(cmd: string, args: string[], r: ExecResult): string | undefined`
  (non-zero exit → `` `${cmd} ${args[0] ?? ""}: exit ${code}: ${firstStderrLine}` ``; else first
  stderr line matching `/\b(error|exception|fail(ed|ure)?|unauthori[sz]ed|forbidden|denied)\b/i`;
  else `undefined`), and `createHost` returns `CheckHost & { problems: string[] }`, pushing
  each exec problem. Tests: exit 2 → problem; stderr "Error: not logged in" with exit 0 →
  problem; stderr "warning: deprecated" → none; fetch 503 → no problem.
- **Task 6**: `validateCode` is replaced by
  `trialRun(code: string, host: CheckHost & { problems: string[] }): Promise<{ error?: string; fire?: boolean; reason?: string; problems: string[] }>`
  (any `!ok` outcome → `error`, thrown or not). `compileTrigger(prose, runner, opts)` gains
  `opts.trialHost: () => CheckHost & { problems: string[] }`. Attempt 1: `error` or
  `problems.length > 0` → retry with that feedback. Attempt 2: `error` → `invalid`;
  problems only → accept. The ok result becomes
  `{ kind: "ok"; trigger: CompiledTrigger; trial: { fire: boolean; reason?: string; problems: string[] } }`.
  Tests use a stub trial host; add: problems on attempt 1 → retry prompt contains them;
  problems on both → `ok` with `trial.problems`; a throw on the trial → retry, then invalid.
- **Task 7**: `TriggerDeps.check` returns `Promise<{ outcome: CheckOutcome; problems: string[] }>`.
  An `ok` outcome with `fire: false` and `problems.length > 0` is handled exactly like an
  error with message `` `exec problems: ${problems.join("; ")}` ``. `trigger-compiled` detail
  is `` `${summary} — would fire now: ${trial.fire ? "yes" : "no"}${trial.reason ? ` (${trial.reason})` : ""}${trial.problems.length ? ` ⚠ ${trial.problems.join("; ")}` : ""}` ``.
  Test: a check returning no-fire with problems three times → one "Trigger check failing"
  comment; fire with problems → fires. The daemon wiring builds the trial host with
  `createHost({ windowStart: now, now, execAllow })`.

## Global Constraints

- Opt-in: `GENE_PROGRAM_TRIGGERS` default `false`; off ⇒ no compiles, no checks, no TUI trigger status.
- `GENE_PROGRAM_TRIGGER_COOLDOWN_MIN` default `30`; `GENE_TRIGGER_EXEC_ALLOW` default empty (comma-separated prefixes); `GENE_TRIGGER_IO_MIN_INTERVAL_MIN` default `5`; `GENE_TRIGGER_COMPILE_MODEL` default `haiku`.
- Sandbox limits: memory 16 MB, stack 512 KB, JS CPU 1 s, wall 60 s, ≤ 10 fetch+exec calls, state ≤ 16 KB JSON, reason ≤ 500 chars, ≤ 20 log lines kept.
- fetch: http/https only, 10 s timeout, body ≤ 1 MB, no credentials added. exec: whole-token prefix allowlist, `execFile` (no shell), 20 s timeout, stdout/stderr ≤ 1 MB each, fresh temp cwd; `glab api` rejects `-X`, `--method`, `-f`, `-F`, `--field`, `--raw-field`, `--input`.
- Interval clamp `[poll interval, 24 h]`; IO floor applies when the previous run used fetch/exec; error backoff `max(base, min(base·2^streak, 1 h))`; comment at `error_streak = 3`, once.
- Manual `g` unchanged: bypasses gates, restarts a running program. A trigger never restarts a running program.
- Ticket comments are posted with `tracker.postComment`, which appends `#gene-ai` itself.
- Match surrounding style: 2-space indent, double quotes, `logger.tag.*` prefixes, JSDoc on exports, `node:test` + `assert/strict`.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Trigger prose edited while a check is mid-flight or a compile is queued** — expect the stale compile result to be discarded (hash compared before saving) and no fire from stale code. Test in Task 7.
- **Daemon restarted after a long downtime with an hourly cron** — expect exactly one catch-up fire, not one per missed hour. Test in Task 5 (`cronDue` over a 10 h window → true once; window then advances).
- **A check that never resolves (awaits a promise nothing settles)** — expect an error outcome ("check did not settle"), not a hang of the scan. Test in Task 3.
- **Store unavailable (DB error) during a trigger scan** — expect a warning and the rest of `scanPrograms` (manual fires, resumes) to continue. Test in Task 7.
- **Program loses its `## Trigger` (set to `manual`) while a fire is already queued** — the queued fire still dispatches once (it was legitimately decided); the trigger row is deleted and no further fires. Test in Task 7.

---

### Task 1: Config keys + fire reason through the queue and prompt

**Files:**
- Modify: `src/config.ts` (env block near `PROGRAM_ALLOWED_TOOLS`, ~line 165)
- Modify: `src/programs.ts:17-46` (fire queue)
- Modify: `src/prompt.ts:28-52` (`PromptInputs`), `src/prompt.ts:303-355` (`buildProgramPrompt`)
- Modify: `src/index.ts` (callers of `fireProgram`/`takeFireRequest`, `dispatchProgram` opts)
- Test: `src/programs.test.ts`, `src/prompt.test.ts`

**Interfaces:**
- Produces:
  - `env.PROGRAM_TRIGGERS: boolean`, `env.PROGRAM_TRIGGER_COOLDOWN_MIN: number`, `env.TRIGGER_EXEC_ALLOW: string[]`, `env.TRIGGER_IO_MIN_INTERVAL_MIN: number`, `env.TRIGGER_COMPILE_MODEL: string`
  - `type FireRequest = { source: ProgramSource; reason?: string }`
  - `fireProgram(identifier: string, source?: ProgramSource, reason?: string): void`
  - `takeFireRequest(identifier: string): FireRequest | undefined`
  - `PromptInputs.fireReason?: string`

- [ ] **Step 1: Write failing tests**

Append to `src/programs.test.ts`:

```ts
test("takeFireRequest returns source and reason, once", () => {
  fireProgram("PRG-R1", "trigger", "!87 needs rebase");
  assert.deepEqual(takeFireRequest("prg-r1"), { source: "trigger", reason: "!87 needs rebase" });
  assert.equal(takeFireRequest("PRG-R1"), undefined);
});

test("manual fire has no reason", () => {
  fireProgram("PRG-R2");
  assert.deepEqual(takeFireRequest("PRG-R2"), { source: "manual", reason: undefined });
});
```

Update any existing assertion in that file that compared `takeFireRequest(...)` to a bare source string (e.g. `"manual"`) to compare `takeFireRequest(...)?.source` instead.

Append to `src/prompt.test.ts` (reuse the file's existing `program` fixture and the input shape of its first program test):

```ts
test("program prompt includes why a trigger fired", () => {
  const prompt = buildPrompt({
    issue: program,
    comments: [],
    worktreePath: "/tmp/.gene/programs/PRG-1",
    intent: "program",
    attachmentRelativePaths: [],
    hasRepo: false,
    fireReason: "!87, !91 need rebase"
  });
  assert.match(prompt, /# Why this run fired/);
  assert.match(prompt, /!87, !91 need rebase/);
});

test("program prompt omits the trigger section for a manual fire", () => {
  const prompt = buildPrompt({
    issue: program,
    comments: [],
    worktreePath: "/tmp/.gene/programs/PRG-1",
    intent: "program",
    attachmentRelativePaths: [],
    hasRepo: false
  });
  assert.doesNotMatch(prompt, /Why this run fired/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/programs.test.ts src/prompt.test.ts`
Expected: FAIL — `takeFireRequest` returns a string; `fireReason` not rendered.

- [ ] **Step 3: Implement**

`src/config.ts`, after `PROGRAM_ALLOWED_TOOLS`:

```ts
  // Program triggers (opt-in). When on, each program's `## Trigger` prose is compiled
  // once into a sandboxed check that fires the program automatically (src/trigger/).
  PROGRAM_TRIGGERS: bool("GENE_PROGRAM_TRIGGERS", false),
  // Minimum minutes between two fires of the same program by its trigger (a manual
  // `g` fire counts as the last fire too).
  PROGRAM_TRIGGER_COOLDOWN_MIN: int("GENE_PROGRAM_TRIGGER_COOLDOWN_MIN", 30),
  // Command prefixes a trigger check may run via gene.exec, e.g.
  // "glab api,argocd app list". Empty ⇒ cron/URL triggers only.
  TRIGGER_EXEC_ALLOW: list("GENE_TRIGGER_EXEC_ALLOW"),
  // Floor (minutes) between runs of a check that calls fetch/exec.
  TRIGGER_IO_MIN_INTERVAL_MIN: int("GENE_TRIGGER_IO_MIN_INTERVAL_MIN", 5),
  // Model for the one-off prose → check compile.
  TRIGGER_COMPILE_MODEL: str("GENE_TRIGGER_COMPILE_MODEL", "haiku"),
```

`src/programs.ts` — replace the queue block:

```ts
/** A queued fire: who asked, and (for a trigger) why — surfaced in the run's prompt. */
export type FireRequest = { source: ProgramSource; reason?: string };

// --- Fire queue (manual `g` and triggers both enqueue here) -------------------------
const pendingFires = new Map<string, FireRequest>();

/** Enqueue a fire for a program (idempotent per identifier; the latest request wins). */
export const fireProgram = (identifier: string, source: ProgramSource = "manual", reason?: string): void => {
  pendingFires.set(identifier.toLowerCase(), { source, reason });
};

export const hasFireRequest = (identifier: string): boolean =>
  pendingFires.has(identifier.toLowerCase());

/** Remove and return a pending fire (undefined if none). Consuming it
 *  guarantees exactly one dispatch per request. */
export const takeFireRequest = (identifier: string): FireRequest | undefined => {
  const key = identifier.toLowerCase();
  const request = pendingFires.get(key);
  if (request !== undefined) pendingFires.delete(key);
  return request;
};
```

`src/prompt.ts` — add to `PromptInputs`:

```ts
  /** Why a trigger fired this program run (program intent only); absent for a manual fire. */
  fireReason?: string;
```

In `buildProgramPrompt`, destructure `fireReason` and insert right after the `issue.description` line block (before `workspace`):

```ts
    ...(fireReason ? ["# Why this run fired", "", `This run was started automatically by the program's trigger: ${fireReason}`, ""] : []),
```

`src/index.ts`:
- `dispatchProgram` opts become `{ source: ProgramSource; recordResting: boolean; reason?: string }`; the concurrency-cap re-enqueue becomes `fireProgram(program.identifier, opts.source, opts.reason)`; pass `fireReason: opts.reason` into `buildPrompt`; include the reason in the `program-fired` record detail: `` `source: ${opts.source}${opts.reason ? ` — ${opts.reason}` : ""} (resting: ${restingNote})` ``.
- In `scanPrograms`: `const request = hasFireRequest(program.identifier) ? takeFireRequest(program.identifier) : undefined; const source = request?.source;` and pass `reason: request?.reason` into the `fire` case's `dispatchProgram` call; the `restart` case re-enqueues with `fireProgram(program.identifier, action.source, request?.reason)`.

- [ ] **Step 4: Run tests + typecheck**

Run: `node --test src/programs.test.ts src/prompt.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/programs.ts src/prompt.ts src/index.ts src/programs.test.ts src/prompt.test.ts
git commit -m "feat(programs): carry a fire reason into the program prompt; trigger config keys"
```

---

### Task 2: `program_trigger` table + store

**Files:**
- Modify: `src/db.ts` (`SCHEMA`, append table)
- Create: `src/trigger/store.ts`
- Test: `src/trigger/store.test.ts`

**Interfaces:**
- Produces:

```ts
export type TriggerStatus = "ok" | "uncompilable" | "invalid";
export type TriggerRow = {
  tracker: string; identifier: string; proseHash: string; status: TriggerStatus;
  summary?: string; code?: string; intervalSec?: number; compileError?: string;
  compiledAt: Date; lastCheckAt?: Date; nextCheckAt?: Date;
  lastOutcome?: string; lastReason?: string; usedIo: boolean;
  errorStreak: number; errorCommented: boolean; state: unknown;
};
export type CompiledFields = Pick<TriggerRow, "tracker" | "identifier" | "proseHash" | "status" | "summary" | "code" | "intervalSec" | "compileError">;
export type CheckUpdate = { lastCheckAt: Date; nextCheckAt: Date; lastOutcome: string; lastReason?: string; usedIo?: boolean; errorStreak?: number; errorCommented?: boolean; state?: unknown };
export interface TriggerStore {
  read(tracker: string, identifier: string): Promise<TriggerRow | null>;
  saveCompiled(fields: CompiledFields, now: Date): Promise<void>;
  recordCheck(tracker: string, identifier: string, update: CheckUpdate): Promise<void>;
  remove(tracker: string, identifier: string): Promise<void>;
}
export const dbTriggerStore: TriggerStore;
```

- [ ] **Step 1: Write the failing test** — `src/trigger/store.test.ts`:

```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the embedded store at a throwaway dir BEFORE db.ts is imported.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gene-trigger-store-"));
process.env.GENE_DB_DIR = path.join(dir, "pgdata");
delete process.env.GENE_DATABASE_URL;

const { dbTriggerStore } = await import("./store.ts");
const { closeDb } = await import("../db.ts");

after(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("saveCompiled then read round-trips and resets runtime fields", async () => {
  const now = new Date("2026-10-07T09:00:00Z");
  await dbTriggerStore.saveCompiled(
    { tracker: "linear", identifier: "PRG-1", proseHash: "h1", status: "ok", summary: "hourly", code: "async function check(){return {fire:false}}", intervalSec: 60 },
    now
  );
  await dbTriggerStore.recordCheck("linear", "PRG-1", {
    lastCheckAt: now, nextCheckAt: new Date(now.getTime() + 60_000), lastOutcome: "error",
    errorStreak: 2, errorCommented: true, usedIo: true, state: { seen: [1] }
  });
  let row = await dbTriggerStore.read("linear", "PRG-1");
  assert.equal(row?.errorStreak, 2);
  assert.deepEqual(row?.state, { seen: [1] });
  assert.equal(row?.usedIo, true);

  await dbTriggerStore.saveCompiled({ tracker: "linear", identifier: "PRG-1", proseHash: "h2", status: "ok", code: "x", intervalSec: 120 }, now);
  row = await dbTriggerStore.read("linear", "PRG-1");
  assert.equal(row?.proseHash, "h2");
  assert.equal(row?.errorStreak, 0);
  assert.equal(row?.errorCommented, false);
  assert.equal(row?.state, null);
  assert.equal(row?.usedIo, false);
  assert.equal(row?.lastCheckAt?.toISOString(), now.toISOString());
  assert.equal(row?.nextCheckAt?.toISOString(), now.toISOString());
});

test("recordCheck leaves state/usedIo alone when omitted", async () => {
  const now = new Date("2026-10-07T10:00:00Z");
  await dbTriggerStore.saveCompiled({ tracker: "linear", identifier: "PRG-2", proseHash: "h", status: "ok", code: "x", intervalSec: 60 }, now);
  await dbTriggerStore.recordCheck("linear", "PRG-2", { lastCheckAt: now, nextCheckAt: now, lastOutcome: "no-fire", usedIo: true, state: { a: 1 } });
  await dbTriggerStore.recordCheck("linear", "PRG-2", { lastCheckAt: now, nextCheckAt: now, lastOutcome: "skipped:busy" });
  const row = await dbTriggerStore.read("linear", "PRG-2");
  assert.deepEqual(row?.state, { a: 1 });
  assert.equal(row?.usedIo, true);
  assert.equal(row?.lastOutcome, "skipped:busy");
});

test("remove deletes the row", async () => {
  await dbTriggerStore.remove("linear", "PRG-2");
  assert.equal(await dbTriggerStore.read("linear", "PRG-2"), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/trigger/store.test.ts`
Expected: FAIL — `Cannot find module './store.ts'`.

- [ ] **Step 3: Implement**

Append to `SCHEMA` in `src/db.ts` (inside the template string, after `program_state`):

```sql
  -- Program triggers: the compiled `## Trigger` check per program plus its run
  -- bookkeeping (src/trigger/). Keyed like program_state.
  CREATE TABLE IF NOT EXISTS program_trigger (
    tracker         TEXT NOT NULL,
    identifier      TEXT NOT NULL,
    prose_hash      TEXT NOT NULL,
    status          TEXT NOT NULL,
    summary         TEXT,
    code            TEXT,
    interval_sec    INTEGER,
    compile_error   TEXT,
    compiled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_check_at   TIMESTAMPTZ,
    next_check_at   TIMESTAMPTZ,
    last_outcome    TEXT,
    last_reason     TEXT,
    used_io         BOOLEAN NOT NULL DEFAULT false,
    error_streak    INTEGER NOT NULL DEFAULT 0,
    error_commented BOOLEAN NOT NULL DEFAULT false,
    state           JSONB,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tracker, identifier)
  );
```

`src/trigger/store.ts`:

```ts
/**
 * Persistence for program triggers (`program_trigger`, schema in db.ts): the compiled
 * check for a program's `## Trigger` prose, keyed by a hash of that prose, plus the
 * bookkeeping its schedule needs (cron window, next run, error streak, gene.state).
 * Exposed as a {@link TriggerStore} interface so the scanner can be tested against a fake.
 */
import { getDb } from "../db.ts";

export type TriggerStatus = "ok" | "uncompilable" | "invalid";

export type TriggerRow = {
  tracker: string;
  identifier: string;
  proseHash: string;
  status: TriggerStatus;
  summary?: string;
  code?: string;
  intervalSec?: number;
  compileError?: string;
  compiledAt: Date;
  lastCheckAt?: Date;
  nextCheckAt?: Date;
  lastOutcome?: string;
  lastReason?: string;
  usedIo: boolean;
  errorStreak: number;
  errorCommented: boolean;
  state: unknown;
};

export type CompiledFields = Pick<
  TriggerRow,
  "tracker" | "identifier" | "proseHash" | "status" | "summary" | "code" | "intervalSec" | "compileError"
>;

export type CheckUpdate = {
  lastCheckAt: Date;
  nextCheckAt: Date;
  lastOutcome: string;
  lastReason?: string;
  usedIo?: boolean;
  errorStreak?: number;
  errorCommented?: boolean;
  state?: unknown;
};

export interface TriggerStore {
  read(tracker: string, identifier: string): Promise<TriggerRow | null>;
  /** Upsert a (re)compile; resets the runtime fields and opens the cron window at `now`. */
  saveCompiled(fields: CompiledFields, now: Date): Promise<void>;
  /** Record one due evaluation (run or skipped). Omitted optional fields keep their value. */
  recordCheck(tracker: string, identifier: string, update: CheckUpdate): Promise<void>;
  remove(tracker: string, identifier: string): Promise<void>;
}

type Raw = {
  tracker: string;
  identifier: string;
  prose_hash: string;
  status: TriggerStatus;
  summary: string | null;
  code: string | null;
  interval_sec: number | null;
  compile_error: string | null;
  compiled_at: Date | string;
  last_check_at: Date | string | null;
  next_check_at: Date | string | null;
  last_outcome: string | null;
  last_reason: string | null;
  used_io: boolean;
  error_streak: number;
  error_commented: boolean;
  state: unknown;
};

const date = (value: Date | string | null): Date | undefined =>
  value === null ? undefined : value instanceof Date ? value : new Date(value);

const toRow = (r: Raw): TriggerRow => ({
  tracker: r.tracker,
  identifier: r.identifier,
  proseHash: r.prose_hash,
  status: r.status,
  summary: r.summary ?? undefined,
  code: r.code ?? undefined,
  intervalSec: r.interval_sec ?? undefined,
  compileError: r.compile_error ?? undefined,
  compiledAt: date(r.compiled_at)!,
  lastCheckAt: date(r.last_check_at),
  nextCheckAt: date(r.next_check_at),
  lastOutcome: r.last_outcome ?? undefined,
  lastReason: r.last_reason ?? undefined,
  usedIo: r.used_io,
  errorStreak: r.error_streak,
  errorCommented: r.error_commented,
  state: r.state ?? null
});

export const dbTriggerStore: TriggerStore = {
  read: async (tracker, identifier) => {
    const db = await getDb();
    const res = await db.query<Raw>("SELECT * FROM program_trigger WHERE tracker = $1 AND identifier = $2", [
      tracker,
      identifier
    ]);
    return res.rows[0] ? toRow(res.rows[0]) : null;
  },
  saveCompiled: async (f, now) => {
    const db = await getDb();
    await db.query(
      `INSERT INTO program_trigger
         (tracker, identifier, prose_hash, status, summary, code, interval_sec, compile_error,
          compiled_at, last_check_at, next_check_at, last_outcome, last_reason, used_io,
          error_streak, error_commented, state, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9, NULL, NULL, false, 0, false, NULL, now())
       ON CONFLICT (tracker, identifier) DO UPDATE SET
         prose_hash = EXCLUDED.prose_hash, status = EXCLUDED.status, summary = EXCLUDED.summary,
         code = EXCLUDED.code, interval_sec = EXCLUDED.interval_sec, compile_error = EXCLUDED.compile_error,
         compiled_at = EXCLUDED.compiled_at, last_check_at = EXCLUDED.last_check_at,
         next_check_at = EXCLUDED.next_check_at, last_outcome = NULL, last_reason = NULL,
         used_io = false, error_streak = 0, error_commented = false, state = NULL, updated_at = now()`,
      [f.tracker, f.identifier, f.proseHash, f.status, f.summary ?? null, f.code ?? null, f.intervalSec ?? null, f.compileError ?? null, now]
    );
  },
  recordCheck: async (tracker, identifier, u) => {
    const db = await getDb();
    await db.query(
      `UPDATE program_trigger SET
         last_check_at = $3, next_check_at = $4, last_outcome = $5, last_reason = $6,
         used_io = COALESCE($7, used_io), error_streak = COALESCE($8, error_streak),
         error_commented = COALESCE($9, error_commented),
         state = CASE WHEN $10::boolean THEN $11::jsonb ELSE state END,
         updated_at = now()
       WHERE tracker = $1 AND identifier = $2`,
      [
        tracker,
        identifier,
        u.lastCheckAt,
        u.nextCheckAt,
        u.lastOutcome,
        u.lastReason ?? null,
        u.usedIo ?? null,
        u.errorStreak ?? null,
        u.errorCommented ?? null,
        u.state !== undefined,
        u.state === undefined ? null : JSON.stringify(u.state)
      ]
    );
  },
  remove: async (tracker, identifier) => {
    const db = await getDb();
    await db.query("DELETE FROM program_trigger WHERE tracker = $1 AND identifier = $2", [tracker, identifier]);
  }
};
```

- [ ] **Step 4: Run tests**

Run: `node --test src/trigger/store.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/trigger/store.ts src/trigger/store.test.ts
git commit -m "feat(trigger): program_trigger table and store"
```

---

### Task 3: QuickJS sandbox (`runCheck`)

**Files:**
- Modify: `package.json` / `package-lock.json` (deps)
- Modify: `sea.json` (asset), `build.mjs` (nothing to bundle specially — verify in Task 9)
- Create: `src/trigger/sandbox.ts`
- Test: `src/trigger/sandbox.test.ts`

**Interfaces:**
- Produces:

```ts
export type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
export type FetchResult = { status: number; headers: Record<string, string>; text: string };
export type ExecResult = { code: number; stdout: string; stderr: string };
export type CheckHost = {
  cron: (expr: string, tz?: string) => boolean;
  fetch: (url: string, init: FetchInit) => Promise<FetchResult>;
  exec: (cmd: string, args: string[]) => Promise<ExecResult>;
  now: () => Date;
};
export type CheckLimits = { memoryBytes: number; stackBytes: number; cpuMs: number; wallMs: number; maxCalls: number; maxStateBytes: number; maxReason: number; maxLogLines: number };
export const DEFAULT_LIMITS: CheckLimits;
export type CheckOutcome =
  | { ok: true; fire: boolean; reason?: string; state: unknown; logs: string[]; usedIo: boolean }
  | { ok: false; error: string; thrown: boolean; logs: string[]; usedIo: boolean };
export const runCheck: (code: string, host: CheckHost, state: unknown, limits?: CheckLimits) => Promise<CheckOutcome>;
```

`thrown: true` marks an exception raised by the user code itself (used by compile validation to tolerate runtime throws); limits, syntax errors, missing `check`, bad shapes are `thrown: false`.

- [ ] **Step 1: Add dependencies**

```bash
npm install quickjs-emscripten-core@0.32.0 @jitl/quickjs-wasmfile-release-sync@0.32.0 cron-parser@5
```

Add to `sea.json` `assets`:

```json
    "quickjs.wasm": "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
```

(Verify the exact wasm filename with `ls node_modules/@jitl/quickjs-wasmfile-release-sync/dist/*.wasm` and use it.)

- [ ] **Step 2: Write the failing tests** — `src/trigger/sandbox.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheck, DEFAULT_LIMITS, type CheckHost } from "./sandbox.ts";

const host = (over: Partial<CheckHost> = {}): CheckHost => ({
  cron: () => false,
  fetch: async () => ({ status: 200, headers: {}, text: "{\"ok\":true}" }),
  exec: async () => ({ code: 0, stdout: "[]", stderr: "" }),
  now: () => new Date("2026-10-07T09:00:00Z"),
  ...over
});

test("returns fire + reason and persists state", async () => {
  const out = await runCheck(
    `async function check(gene) { gene.state = { n: (gene.state?.n ?? 0) + 1 }; return { fire: true, reason: "go" }; }`,
    host(),
    { n: 41 }
  );
  assert.deepEqual(out, { ok: true, fire: true, reason: "go", state: { n: 42 }, logs: [], usedIo: false });
});

test("cron is synchronous and passes tz", async () => {
  const seen: unknown[] = [];
  const out = await runCheck(
    `async function check(gene) { return { fire: gene.cron("0 9 * * 1-5", { tz: "Europe/Berlin" }) }; }`,
    host({ cron: (e, tz) => (seen.push([e, tz]), true) }),
    null
  );
  assert.equal(out.ok && out.fire, true);
  assert.deepEqual(seen, [["0 9 * * 1-5", "Europe/Berlin"]]);
});

test("fetch and exec round-trip and mark usedIo", async () => {
  const out = await runCheck(
    `async function check(gene) {
       const r = await gene.fetch("https://x/health");
       const e = await gene.exec("glab", ["api", "merge_requests"]);
       return { fire: r.json().ok && JSON.parse(e.stdout).length === 0, reason: String(r.status) };
     }`,
    host(),
    null
  );
  assert.deepEqual(out.ok && [out.fire, out.reason, out.usedIo], [true, "200", true]);
});

test("host rejection surfaces as a thrown error in the check", async () => {
  const out = await runCheck(
    `async function check(gene) { await gene.exec("rm", ["-rf", "/"]); return { fire: true }; }`,
    host({ exec: async () => { throw new Error("exec not allowed: rm"); } }),
    null
  );
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /exec not allowed: rm/);
  assert.equal(!out.ok && out.thrown, true);
});

test("no ambient capabilities", async () => {
  const out = await runCheck(
    `async function check() { return { fire: false, reason: [typeof process, typeof require, typeof setTimeout, typeof fetch].join(",") }; }`,
    host(),
    null
  );
  assert.equal(out.ok && out.reason, "undefined,undefined,undefined,undefined");
});

test("missing check function", async () => {
  const out = await runCheck(`const x = 1;`, host(), null);
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /check is not a function/);
  assert.equal(!out.ok && out.thrown, false);
});

test("syntax error", async () => {
  const out = await runCheck(`async function check( {`, host(), null);
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.thrown, false);
});

test("bad result shape", async () => {
  for (const ret of [`{}`, `{ fire: "yes" }`, `true`, `null`]) {
    const out = await runCheck(`async function check() { return ${ret}; }`, host(), null);
    assert.equal(out.ok, false, ret);
    assert.match(!out.ok ? out.error : "", /must return \{ fire: boolean/);
  }
});

test("reason truncated to 500 chars", async () => {
  const out = await runCheck(`async function check() { return { fire: true, reason: "x".repeat(900) }; }`, host(), null);
  assert.equal(out.ok && out.reason?.length, 500);
});

test("CPU limit stops a busy loop", async () => {
  const started = Date.now();
  const out = await runCheck(`async function check() { for (;;) {} }`, host(), null, { ...DEFAULT_LIMITS, cpuMs: 100 });
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /interrupted|CPU/i);
  assert.ok(Date.now() - started < 5_000);
});

test("memory limit", async () => {
  const out = await runCheck(
    `async function check() { const a = []; for (;;) a.push("x".repeat(1e5)); }`,
    host(),
    null,
    { ...DEFAULT_LIMITS, memoryBytes: 4 * 1024 * 1024, cpuMs: 5_000 }
  );
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.thrown, false);
});

test("wall clock limit while awaiting a slow host call", async () => {
  const out = await runCheck(
    `async function check(gene) { await gene.fetch("https://slow"); return { fire: true }; }`,
    host({ fetch: () => new Promise(() => {}) }),
    null,
    { ...DEFAULT_LIMITS, wallMs: 200 }
  );
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /wall/i);
});

test("a check that never settles errors instead of hanging", async () => {
  const out = await runCheck(`async function check() { await new Promise(() => {}); }`, host(), null);
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /did not settle/);
});

test("call budget", async () => {
  const out = await runCheck(
    `async function check(gene) { for (let i = 0; i < 11; i++) await gene.exec("glab", ["api", "x"]); return { fire: false }; }`,
    host(),
    null
  );
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /more than 10/);
});

test("state too large or not JSON", async () => {
  const big = await runCheck(`async function check(gene) { gene.state = "x".repeat(20000); return { fire: false }; }`, host(), null);
  assert.match(!big.ok ? big.error : "", /state/);
  const cyc = await runCheck(`async function check(gene) { const a = {}; a.a = a; gene.state = a; return { fire: false }; }`, host(), null);
  assert.equal(cyc.ok, false);
});

test("log lines are captured and capped", async () => {
  const out = await runCheck(`async function check(gene) { for (let i = 0; i < 30; i++) gene.log("l" + i); return { fire: false }; }`, host(), null);
  assert.equal(out.logs.length, 20);
  assert.equal(out.logs[0], "l0");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test src/trigger/sandbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/trigger/sandbox.ts`**

```ts
/**
 * Runs a compiled trigger check in a QuickJS sandbox. The check is untrusted (compiled
 * from ticket prose), so the sandbox is the security boundary: a fresh runtime per run,
 * no ambient globals, and only the `gene` API — whose capabilities are host functions
 * injected by the caller (see host.ts for the real ones). Knows nothing about programs.
 */
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSWASMModule, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten-core";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import { inSea, wasmAsset } from "../sea-assets.ts";

export type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
export type FetchResult = { status: number; headers: Record<string, string>; text: string };
export type ExecResult = { code: number; stdout: string; stderr: string };

export type CheckHost = {
  cron: (expr: string, tz?: string) => boolean;
  fetch: (url: string, init: FetchInit) => Promise<FetchResult>;
  exec: (cmd: string, args: string[]) => Promise<ExecResult>;
  now: () => Date;
};

export type CheckLimits = {
  memoryBytes: number;
  stackBytes: number;
  cpuMs: number;
  wallMs: number;
  maxCalls: number;
  maxStateBytes: number;
  maxReason: number;
  maxLogLines: number;
};

export const DEFAULT_LIMITS: CheckLimits = {
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 512 * 1024,
  cpuMs: 1_000,
  wallMs: 60_000,
  maxCalls: 10,
  maxStateBytes: 16 * 1024,
  maxReason: 500,
  maxLogLines: 20
};

export type CheckOutcome =
  | { ok: true; fire: boolean; reason?: string; state: unknown; logs: string[]; usedIo: boolean }
  | { ok: false; error: string; thrown: boolean; logs: string[]; usedIo: boolean };

let modulePromise: Promise<QuickJSWASMModule> | null = null;

/** Load the QuickJS WASM once per process — from the SEA asset in the binary, else from node_modules. */
const loadQuickJS = (): Promise<QuickJSWASMModule> => {
  modulePromise ??= newQuickJSWASMModuleFromVariant(
    inSea() ? newVariant(releaseSync, { wasmModule: wasmAsset("quickjs.wasm") }) : releaseSync
  );
  return modulePromise;
};

// The in-sandbox side of the `gene` API. Host functions speak JSON strings so no
// handle juggling leaks into user code; `__host_async` returns a promise.
const PRELUDE = `
  const __call = async (name, args) => JSON.parse(await __host_async(name, JSON.stringify(args)));
  globalThis.gene = {
    cron: (expr, opts) => __host_cron(String(expr), opts && opts.tz ? String(opts.tz) : ""),
    fetch: async (url, opts) => {
      const r = await __call("fetch", [String(url), opts || {}]);
      return { status: r.status, headers: r.headers, text: r.text, json: () => JSON.parse(r.text) };
    },
    exec: (cmd, args) => __call("exec", [String(cmd), (args || []).map(String)]),
    now: () => __host_now(),
    log: msg => __host_log(String(msg)),
    state: JSON.parse(__initial_state)
  };
`;

const RUNNER = `
  (async () => {
    if (typeof check !== "function") throw { __gene: "check is not a function" };
    let result;
    try {
      result = await check(gene);
    } catch (error) {
      throw { __thrown: String(error && error.message ? error.message : error) };
    }
    let state;
    try {
      state = JSON.stringify(gene.state === undefined ? null : gene.state);
    } catch (error) {
      throw { __gene: "gene.state is not JSON-serialisable" };
    }
    return JSON.stringify({ result, state });
  })()
`;

const SHAPE_ERROR = "check must return { fire: boolean, reason?: string }";

export const runCheck = async (
  code: string,
  host: CheckHost,
  state: unknown,
  limits: CheckLimits = DEFAULT_LIMITS
): Promise<CheckOutcome> => {
  const QuickJS = await loadQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);

  // CPU budget counts only synchronous JS slices; awaiting host calls is excluded.
  let cpuLeft = limits.cpuMs;
  let sliceStart = 0;
  let cpuExceeded = false;
  runtime.setInterruptHandler(() => {
    if (performance.now() - sliceStart > cpuLeft) {
      cpuExceeded = true;
      return true;
    }
    return false;
  });
  const slice = <T>(fn: () => T): T => {
    sliceStart = performance.now();
    try {
      return fn();
    } finally {
      cpuLeft -= performance.now() - sliceStart;
    }
  };

  const ctx: QuickJSContext = runtime.newContext();
  const logs: string[] = [];
  let calls = 0;
  let usedIo = false;
  const inflight = new Set<Promise<void>>();
  const fail = (error: string, thrown = false): CheckOutcome => ({ ok: false, error, thrown, logs, usedIo });

  try {
    const fn = (name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle | undefined): void => {
      const handle = ctx.newFunction(name, impl);
      ctx.setProp(ctx.global, name, handle);
      handle.dispose();
    };
    fn("__host_cron", (expr, tz) => {
      const tzValue = ctx.getString(tz);
      return host.cron(ctx.getString(expr), tzValue === "" ? undefined : tzValue) ? ctx.true : ctx.false;
    });
    fn("__host_now", () => ctx.newString(host.now().toISOString()));
    fn("__host_log", msg => {
      if (logs.length < limits.maxLogLines) logs.push(ctx.getString(msg));
      return undefined;
    });
    fn("__host_async", (nameHandle, argsHandle) => {
      const name = ctx.getString(nameHandle);
      const args = JSON.parse(ctx.getString(argsHandle)) as unknown[];
      const deferred = ctx.newPromise();
      calls += 1;
      usedIo = true;
      const work: Promise<unknown> =
        calls > limits.maxCalls
          ? Promise.reject(new Error(`more than ${limits.maxCalls} fetch/exec calls`))
          : name === "fetch"
            ? host.fetch(String(args[0]), (args[1] ?? {}) as FetchInit)
            : host.exec(String(args[0]), (args[1] ?? []) as string[]);
      const settled = work.then(
        value => {
          if (!ctx.alive) return;
          const h = ctx.newString(JSON.stringify(value));
          deferred.resolve(h);
          h.dispose();
        },
        (error: unknown) => {
          if (!ctx.alive) return;
          const h = ctx.newError(error instanceof Error ? error.message : String(error));
          deferred.reject(h);
          h.dispose();
        }
      );
      const tracked = settled.finally(() => inflight.delete(tracked));
      inflight.add(tracked);
      return deferred.handle;
    });
    const stateHandle = ctx.newString(JSON.stringify(state ?? null));
    ctx.setProp(ctx.global, "__initial_state", stateHandle);
    stateHandle.dispose();

    const prelude = slice(() => ctx.evalCode(PRELUDE, "prelude.js"));
    if (prelude.error) {
      const err = ctx.dump(prelude.error);
      prelude.error.dispose();
      return fail(`prelude failed: ${JSON.stringify(err)}`);
    }
    prelude.value.dispose();

    const loaded = slice(() => ctx.evalCode(code, "check.js"));
    if (loaded.error) {
      const err = ctx.dump(loaded.error) as { message?: string } | string;
      loaded.error.dispose();
      if (cpuExceeded) return fail("check interrupted: CPU limit exceeded");
      return fail(`load failed: ${typeof err === "string" ? err : err?.message ?? JSON.stringify(err)}`);
    }
    loaded.value.dispose();

    const started = Date.now();
    const run = slice(() => ctx.evalCode(RUNNER, "runner.js"));
    if (run.error) {
      run.error.dispose();
      return fail(cpuExceeded ? "check interrupted: CPU limit exceeded" : "runner failed");
    }
    const promise = run.value;
    try {
      for (;;) {
        const jobs = slice(() => runtime.executePendingJobs());
        if (jobs.error) {
          jobs.error.dispose();
          return fail(cpuExceeded ? "check interrupted: CPU limit exceeded" : "check failed while running jobs");
        }
        if (cpuExceeded) return fail("check interrupted: CPU limit exceeded");
        const st = ctx.getPromiseState(promise);
        if (st.type === "fulfilled") {
          const json = ctx.getString(st.value);
          st.value.dispose();
          return finish(json);
        }
        if (st.type === "rejected") {
          const err = ctx.dump(st.error) as { __gene?: string; __thrown?: string; message?: string } | string;
          st.error.dispose();
          if (cpuExceeded) return fail("check interrupted: CPU limit exceeded");
          if (typeof err === "object" && err?.__gene) return fail(err.__gene);
          if (typeof err === "object" && err?.__thrown !== undefined) return fail(err.__thrown, true);
          return fail(typeof err === "string" ? err : err?.message ?? "check failed");
        }
        if (inflight.size === 0) return fail("check did not settle (awaited a promise nothing resolves)");
        const left = limits.wallMs - (Date.now() - started);
        if (left <= 0) return fail(`wall clock limit (${limits.wallMs} ms) exceeded`);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          Promise.race(inflight).then(() => false),
          new Promise<boolean>(resolve => {
            timer = setTimeout(() => resolve(true), left);
          })
        ]);
        clearTimeout(timer);
        if (timedOut) return fail(`wall clock limit (${limits.wallMs} ms) exceeded`);
      }
    } finally {
      promise.dispose();
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    ctx.dispose();
    runtime.dispose();
  }

  function finish(json: string): CheckOutcome {
    const { result, state: stateJson } = JSON.parse(json) as { result: unknown; state: string };
    if (
      result === null ||
      typeof result !== "object" ||
      typeof (result as { fire?: unknown }).fire !== "boolean" ||
      ((result as { reason?: unknown }).reason !== undefined && typeof (result as { reason?: unknown }).reason !== "string")
    ) {
      return fail(SHAPE_ERROR);
    }
    if (Buffer.byteLength(stateJson) > limits.maxStateBytes) {
      return fail(`gene.state is larger than ${limits.maxStateBytes} bytes`);
    }
    const { fire, reason } = result as { fire: boolean; reason?: string };
    return {
      ok: true,
      fire,
      reason: reason === undefined ? undefined : reason.slice(0, limits.maxReason),
      state: JSON.parse(stateJson),
      logs,
      usedIo
    };
  }
};
```

Notes for the implementer:
- `getPromiseState` and `newPromise` exist in quickjs-emscripten-core 0.32. If a method name differs, check `node_modules/quickjs-emscripten-core/dist/index.d.ts` and adapt — keep the behaviour the tests pin.
- An `ok: true` result with `reason: undefined` must still `deepEqual` the first test's expectation (which includes `reason: "go"`); an absent reason yields the key with `undefined` — tests compare with `out.ok && out.reason` so that's fine.
- If memory-limit exhaustion surfaces as a QuickJS `InternalError: out of memory` via `loaded.error`/job error rather than a rejection, it falls into the `fail(..., thrown=false)` branches already; if it surfaces through the RUNNER's `catch` as `__thrown`, wrap: treat messages matching `/out of memory/i` as `thrown: false`.

- [ ] **Step 5: Run tests**

Run: `node --test src/trigger/sandbox.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json sea.json src/trigger/sandbox.ts src/trigger/sandbox.test.ts
git commit -m "feat(trigger): QuickJS sandbox for compiled trigger checks"
```

---

### Task 4: Real host functions (`cron`, `fetch`, `exec`)

**Files:**
- Create: `src/trigger/host.ts`
- Test: `src/trigger/host.test.ts`

**Interfaces:**
- Consumes: `CheckHost`, `FetchInit`, `FetchResult`, `ExecResult` from `./sandbox.ts`
- Produces:
  - `cronDue(expr: string, tz: string | undefined, windowStart: Date, now: Date): boolean`
  - `execAllowed(cmd: string, args: string[], allow: string[]): string | undefined` — `undefined` = allowed, else the rejection message
  - `createHost(opts: { windowStart: Date; now: Date; execAllow: string[]; env?: NodeJS.ProcessEnv }): CheckHost`

- [ ] **Step 1: Write failing tests** — `src/trigger/host.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { cronDue, execAllowed, createHost } from "./host.ts";

const at = (iso: string) => new Date(iso);

test("cronDue: tick inside (windowStart, now]", () => {
  assert.equal(cronDue("0 * * * *", undefined, at("2026-10-07T08:59:00Z"), at("2026-10-07T09:00:30Z")), true);
  assert.equal(cronDue("0 * * * *", undefined, at("2026-10-07T09:00:00Z"), at("2026-10-07T09:30:00Z")), false);
});

test("cronDue: long downtime catches up once (a single boolean for the whole window)", () => {
  assert.equal(cronDue("0 * * * *", undefined, at("2026-10-07T00:30:00Z"), at("2026-10-07T10:30:00Z")), true);
});

test("cronDue: honours tz", () => {
  // 09:00 Europe/Berlin (CEST, UTC+2) = 07:00Z
  assert.equal(cronDue("0 9 * * *", "Europe/Berlin", at("2026-10-07T06:59:00Z"), at("2026-10-07T07:00:10Z")), true);
  assert.equal(cronDue("0 9 * * *", undefined, at("2026-10-07T06:59:00Z"), at("2026-10-07T07:00:10Z")), false);
});

test("cronDue: invalid expression throws", () => {
  assert.throws(() => cronDue("not cron", undefined, at("2026-10-07T00:00:00Z"), at("2026-10-07T01:00:00Z")));
});

test("execAllowed: whole-token prefixes", () => {
  const allow = ["glab api", "argocd app list"];
  assert.equal(execAllowed("glab", ["api", "merge_requests"], allow), undefined);
  assert.equal(execAllowed("argocd", ["app", "list", "-o", "json"], allow), undefined);
  assert.match(execAllowed("glab", ["apix"], allow) ?? "", /not allowed/);
  assert.match(execAllowed("argocd", ["app", "sync", "x"], allow) ?? "", /not allowed/);
  assert.match(execAllowed("rm", ["-rf", "/"], []) ?? "", /not allowed/);
});

test("execAllowed: glab api write flags rejected", () => {
  for (const flag of [["-X", "POST"], ["-XPOST"], ["--method", "PUT"], ["--method=PUT"], ["-f", "a=b"], ["-F", "a=b"], ["--field", "a=b"], ["--raw-field", "a=b"], ["--input", "f"]]) {
    assert.match(execAllowed("glab", ["api", "x", ...flag], ["glab api"]) ?? "", /read-only/, flag.join(" "));
  }
});

test("exec runs without a shell, captures output and exit code", async () => {
  const host = createHost({ windowStart: new Date(), now: new Date(), execAllow: [process.execPath] });
  const r = await host.exec(process.execPath, ["-e", "process.stdout.write('hi $(whoami)'); process.exit(3)"]);
  assert.deepEqual(r, { code: 3, stdout: "hi $(whoami)", stderr: "" });
});

test("exec rejects commands off the allowlist", async () => {
  const host = createHost({ windowStart: new Date(), now: new Date(), execAllow: [] });
  await assert.rejects(host.exec("ls", []), /not allowed/);
});

test("exec truncates huge output", async () => {
  const host = createHost({ windowStart: new Date(), now: new Date(), execAllow: [process.execPath] });
  const r = await host.exec(process.execPath, ["-e", "process.stdout.write('x'.repeat(3*1024*1024))"]);
  assert.equal(r.stdout.length, 1024 * 1024);
});

test("fetch: http(s) only", async () => {
  const host = createHost({ windowStart: new Date(), now: new Date(), execAllow: [] });
  await assert.rejects(host.fetch("file:///etc/passwd", {}), /http/);
});

test("fetch: returns status, headers, text", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("x-a", "1");
    res.statusCode = 503;
    res.end("down");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const host = createHost({ windowStart: new Date(), now: new Date(), execAllow: [] });
    const r = await host.fetch(`http://127.0.0.1:${port}/`, {});
    assert.equal(r.status, 503);
    assert.equal(r.text, "down");
    assert.equal(r.headers["x-a"], "1");
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/trigger/host.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/trigger/host.ts`**

```ts
/**
 * The real capabilities behind a trigger check's `gene` API: cron windows, HTTP, and
 * allowlisted CLI calls. Everything a check can reach goes through here, so the limits
 * live here too (timeouts, output caps, the exec allowlist, glab api read-only).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import type { CheckHost, ExecResult, FetchInit, FetchResult } from "./sandbox.ts";

const FETCH_TIMEOUT_MS = 10_000;
const EXEC_TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 1024 * 1024;

/** True when `expr` has a scheduled tick in `(windowStart, now]`. Throws on an invalid expression. */
export const cronDue = (expr: string, tz: string | undefined, windowStart: Date, now: Date): boolean => {
  const it = CronExpressionParser.parse(expr, { currentDate: windowStart, ...(tz ? { tz } : {}) });
  return it.next().toDate().getTime() <= now.getTime();
};

const GLAB_WRITE_FLAGS = new Set(["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"]);

/** `undefined` when `cmd args` starts with a whole-token allowlist entry; otherwise why not. */
export const execAllowed = (cmd: string, args: string[], allow: string[]): string | undefined => {
  const tokens = [cmd, ...args];
  const ok = allow.some(entry => {
    const want = entry.trim().split(/\s+/).filter(Boolean);
    return want.length > 0 && want.every((t, i) => tokens[i] === t);
  });
  if (!ok) return `exec not allowed: ${tokens.slice(0, 3).join(" ")} (GENE_TRIGGER_EXEC_ALLOW)`;
  if (cmd === "glab" && args[0] === "api") {
    const bad = args.find(a => GLAB_WRITE_FLAGS.has(a) || a.startsWith("-X") || a.startsWith("--method="));
    if (bad) return `glab api is read-only in triggers (rejected ${bad})`;
  }
  return undefined;
};

const readCapped = async (res: Response): Promise<string> => {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_OUTPUT - size;
    chunks.push(value.length > room ? value.subarray(0, room) : value);
    size += Math.min(value.length, room);
    if (size >= MAX_OUTPUT) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
};

export const createHost = (opts: {
  windowStart: Date;
  now: Date;
  execAllow: string[];
  env?: NodeJS.ProcessEnv;
}): CheckHost => ({
  cron: (expr, tz) => cronDue(expr, tz, opts.windowStart, opts.now),
  now: () => opts.now,
  fetch: async (url: string, init: FetchInit): Promise<FetchResult> => {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`fetch only supports http/https, got ${parsed.protocol}`);
    }
    const res = await fetch(parsed, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: res.status, headers, text: await readCapped(res) };
  },
  exec: (cmd: string, args: string[]): Promise<ExecResult> => {
    const denied = execAllowed(cmd, args, opts.execAllow);
    if (denied) return Promise.reject(new Error(denied));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gene-trigger-"));
    return new Promise(resolve => {
      execFile(
        cmd,
        args,
        { cwd, env: opts.env ?? process.env, timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: "utf-8" },
        (error, stdout, stderr) => {
          fs.rmSync(cwd, { recursive: true, force: true });
          const code =
            error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
          resolve({ code, stdout: String(stdout).slice(0, MAX_OUTPUT), stderr: String(stderr).slice(0, MAX_OUTPUT) });
        }
      );
    });
  }
});
```

Note: `maxBuffer` overflow kills the child and reports `code: -1` with the output collected so far — the truncation test asserts only `stdout.length`. If Node returns more than `MAX_OUTPUT` chars in `stdout`, the `.slice` caps it.

- [ ] **Step 4: Run tests**

Run: `node --test src/trigger/host.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trigger/host.ts src/trigger/host.test.ts
git commit -m "feat(trigger): host capabilities — cron window, capped fetch, allowlisted exec"
```

---

### Task 5: Schedule — gates, intervals, durations

**Files:**
- Create: `src/trigger/schedule.ts`
- Test: `src/trigger/schedule.test.ts`

**Interfaces:**
- Produces:
  - `type TriggerGate = { kind: "not-due" } | { kind: "skip"; reason: "busy" | "cooldown" } | { kind: "run" }`
  - `decideTrigger(i: { now: Date; nextCheckAt?: Date; resting: boolean; lastFiredAt?: Date; cooldownMs: number }): TriggerGate`
  - `effectiveIntervalMs(i: { intervalSec?: number; usedIo: boolean; errorStreak: number; pollMs: number; ioFloorMs: number }): number`
  - `parseDurationSec(text: string): number | undefined` — `"90s" | "15m" | "1h" | "1d"`

- [ ] **Step 1: Write failing tests** — `src/trigger/schedule.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTrigger, effectiveIntervalMs, parseDurationSec } from "./schedule.ts";

const now = new Date("2026-10-07T09:00:00Z");
const min = 60_000;

test("not due before next_check_at", () => {
  assert.deepEqual(decideTrigger({ now, nextCheckAt: new Date(now.getTime() + 1), resting: true, cooldownMs: 30 * min }), { kind: "not-due" });
});

test("due with no next_check_at", () => {
  assert.deepEqual(decideTrigger({ now, resting: true, cooldownMs: 30 * min }), { kind: "run" });
});

test("busy beats cooldown", () => {
  assert.deepEqual(
    decideTrigger({ now, nextCheckAt: now, resting: false, lastFiredAt: now, cooldownMs: 30 * min }),
    { kind: "skip", reason: "busy" }
  );
});

test("cooldown measured from last fire of any source", () => {
  const recent = new Date(now.getTime() - 29 * min);
  const old = new Date(now.getTime() - 31 * min);
  assert.deepEqual(decideTrigger({ now, nextCheckAt: now, resting: true, lastFiredAt: recent, cooldownMs: 30 * min }), { kind: "skip", reason: "cooldown" });
  assert.deepEqual(decideTrigger({ now, nextCheckAt: now, resting: true, lastFiredAt: old, cooldownMs: 30 * min }), { kind: "run" });
});

test("interval clamps to [poll, 24h]", () => {
  const base = { usedIo: false, errorStreak: 0, pollMs: min, ioFloorMs: 5 * min };
  assert.equal(effectiveIntervalMs({ ...base, intervalSec: 10 }), min);
  assert.equal(effectiveIntervalMs({ ...base, intervalSec: 7 * 86400 }), 86_400_000);
  assert.equal(effectiveIntervalMs({ ...base, intervalSec: undefined }), min);
});

test("io floor applies only after an IO run", () => {
  const base = { intervalSec: 60, errorStreak: 0, pollMs: min, ioFloorMs: 5 * min };
  assert.equal(effectiveIntervalMs({ ...base, usedIo: false }), min);
  assert.equal(effectiveIntervalMs({ ...base, usedIo: true }), 5 * min);
});

test("error backoff doubles, capped at 1h, never shortens a long interval", () => {
  const base = { usedIo: false, pollMs: min, ioFloorMs: 5 * min };
  assert.equal(effectiveIntervalMs({ ...base, intervalSec: 300, errorStreak: 1 }), 10 * min);
  assert.equal(effectiveIntervalMs({ ...base, intervalSec: 300, errorStreak: 10 }), 60 * min);
  assert.equal(effectiveIntervalMs({ ...base, intervalSec: 86400, errorStreak: 3 }), 86_400_000);
});

test("parseDurationSec", () => {
  assert.equal(parseDurationSec("90s"), 90);
  assert.equal(parseDurationSec("15m"), 900);
  assert.equal(parseDurationSec(" 1h "), 3600);
  assert.equal(parseDurationSec("1d"), 86400);
  assert.equal(parseDurationSec("soon"), undefined);
  assert.equal(parseDurationSec("0m"), undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/trigger/schedule.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/trigger/schedule.ts`**

```ts
/**
 * Pure scheduling rules for trigger checks: when a check is due, which gate skips it
 * (busy / cooldown), and how long until the next evaluation. No I/O — the scanner
 * (index.ts) feeds it the facts and acts on the verdict.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type TriggerGate = { kind: "not-due" } | { kind: "skip"; reason: "busy" | "cooldown" } | { kind: "run" };

export const decideTrigger = (i: {
  now: Date;
  nextCheckAt?: Date;
  /** Program at rest: not active/blocked, no run in flight, no fire queued. */
  resting: boolean;
  /** Last fire of any source (manual `g` included). */
  lastFiredAt?: Date;
  cooldownMs: number;
}): TriggerGate => {
  if (i.nextCheckAt && i.now.getTime() < i.nextCheckAt.getTime()) return { kind: "not-due" };
  if (!i.resting) return { kind: "skip", reason: "busy" };
  if (i.lastFiredAt && i.now.getTime() - i.lastFiredAt.getTime() < i.cooldownMs) {
    return { kind: "skip", reason: "cooldown" };
  }
  return { kind: "run" };
};

export const effectiveIntervalMs = (i: {
  intervalSec?: number;
  usedIo: boolean;
  errorStreak: number;
  pollMs: number;
  ioFloorMs: number;
}): number => {
  let base = Math.min(Math.max((i.intervalSec ?? 0) * 1000, i.pollMs), DAY_MS);
  if (i.usedIo) base = Math.max(base, i.ioFloorMs);
  if (i.errorStreak > 0) base = Math.max(base, Math.min(base * 2 ** i.errorStreak, HOUR_MS));
  return base;
};

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** "90s" / "15m" / "1h" / "1d" → seconds; undefined for anything else (or zero). */
export const parseDurationSec = (text: string): number | undefined => {
  const m = /^(\d+)\s*([smhd])$/.exec(text.trim());
  if (!m) return undefined;
  const value = Number(m[1]) * UNITS[m[2]!]!;
  return value > 0 ? value : undefined;
};
```

- [ ] **Step 4: Run tests**

Run: `node --test src/trigger/schedule.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trigger/schedule.ts src/trigger/schedule.test.ts
git commit -m "feat(trigger): pure gates, interval clamp/backoff, duration parsing"
```

---

### Task 6: Compile — prose → validated check

**Files:**
- Create: `src/trigger/compile.ts`
- Test: `src/trigger/compile.test.ts`

**Interfaces:**
- Consumes: `runCheck`, `CheckHost` (Task 3); `parseDurationSec` (Task 5)
- Produces:

```ts
export type CompileRunner = (prompt: string) => Promise<string>;
export type CompiledTrigger = { summary: string; intervalSec: number; code: string };
export type CompileResult =
  | { kind: "ok"; trigger: CompiledTrigger }
  | { kind: "uncompilable"; reason: string }
  | { kind: "invalid"; error: string };
export const normaliseTriggerProse: (section: string) => string | null;
export const proseHash: (prose: string) => string;
export const buildCompilePrompt: (prose: string, opts: { execAllow: string[]; ioFloorMin: number; previousError?: string }) => string;
export const parseCompileReply: (text: string) => CompileResult;
export const validateCode: (code: string) => Promise<string | undefined>;
export const compileTrigger: (prose: string, runner: CompileRunner, opts: { execAllow: string[]; ioFloorMin: number }) => Promise<CompileResult>;
export const claudeRunner: (model: string) => CompileRunner;
```

- [ ] **Step 1: Write failing tests** — `src/trigger/compile.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normaliseTriggerProse,
  proseHash,
  buildCompilePrompt,
  parseCompileReply,
  validateCode,
  compileTrigger
} from "./compile.ts";

const reply = (code: string, interval = "1m", summary = "Hourly") =>
  `SUMMARY: ${summary}\nINTERVAL: ${interval}\n\`\`\`js\n${code}\n\`\`\`\n`;

test("normaliseTriggerProse: manual/none/empty mean no trigger", () => {
  for (const s of ["", "  ", "manual", "None", " MANUAL \n"]) assert.equal(normaliseTriggerProse(s), null);
  assert.equal(normaliseTriggerProse("  every hour \n"), "every hour");
});

test("proseHash is stable and whitespace-insensitive at the edges", () => {
  assert.equal(proseHash("every hour"), proseHash("every hour"));
  assert.notEqual(proseHash("every hour"), proseHash("every day"));
  assert.match(proseHash("x"), /^[0-9a-f]{64}$/);
});

test("prompt lists allowed exec prefixes and the previous error", () => {
  const p = buildCompilePrompt("every hour", { execAllow: ["glab api"], ioFloorMin: 5, previousError: "boom" });
  assert.match(p, /every hour/);
  assert.match(p, /`glab api`/);
  assert.match(p, /boom/);
  const none = buildCompilePrompt("x", { execAllow: [], ioFloorMin: 5 });
  assert.match(none, /exec is not available/);
});

test("parseCompileReply: ok", () => {
  const r = parseCompileReply(reply(`async function check(gene) { return { fire: gene.cron("0 * * * *") }; }`, "15m", "Every hour"));
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") {
    assert.equal(r.trigger.summary, "Every hour");
    assert.equal(r.trigger.intervalSec, 900);
    assert.match(r.trigger.code, /function check/);
  }
});

test("parseCompileReply: uncompilable", () => {
  assert.deepEqual(parseCompileReply("UNCOMPILABLE: no schedule or condition"), { kind: "uncompilable", reason: "no schedule or condition" });
});

test("parseCompileReply: missing parts are invalid", () => {
  assert.equal(parseCompileReply("hello").kind, "invalid");
  assert.equal(parseCompileReply("SUMMARY: x\nINTERVAL: soon\n```js\nx\n```").kind, "invalid");
});

test("validateCode tolerates a runtime throw on stub data", async () => {
  assert.equal(await validateCode(`async function check(gene) { const r = await gene.fetch("https://x"); return { fire: r.json().items.length > 0 }; }`), undefined);
});

test("validateCode rejects syntax, missing check, bad shape", async () => {
  assert.ok(await validateCode(`async function check( {`));
  assert.ok(await validateCode(`const x = 1`));
  assert.match((await validateCode(`async function check() { return { fire: "y" }; }`)) ?? "", /must return/);
});

test("compileTrigger retries once with the validation error", async () => {
  const prompts: string[] = [];
  const answers = [reply(`async function check() { return 1; }`), reply(`async function check() { return { fire: false }; }`)];
  const result = await compileTrigger("every hour", async p => (prompts.push(p), answers.shift()!), { execAllow: [], ioFloorMin: 5 });
  assert.equal(result.kind, "ok");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /must return/);
});

test("compileTrigger gives up after the retry", async () => {
  const result = await compileTrigger("every hour", async () => reply(`nope(`), { execAllow: [], ioFloorMin: 5 });
  assert.equal(result.kind, "invalid");
});

test("compileTrigger does not retry an UNCOMPILABLE answer", async () => {
  let calls = 0;
  const result = await compileTrigger("vibes", async () => (calls++, "UNCOMPILABLE: no schedule"), { execAllow: [], ioFloorMin: 5 });
  assert.deepEqual([result.kind, calls], ["uncompilable", 1]);
});

test("compileTrigger: runner failure is invalid, not a throw", async () => {
  const result = await compileTrigger("every hour", async () => { throw new Error("claude exited 1"); }, { execAllow: [], ioFloorMin: 5 });
  assert.equal(result.kind, "invalid");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/trigger/compile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/trigger/compile.ts`**

```ts
/**
 * Compiles a program's free-form `## Trigger` prose into a `check(gene)` function, once
 * per prose hash. A short tool-less `claude -p` run writes the code; we parse it,
 * validate it in the sandbox against stub host functions, and retry once with the error.
 * The runner is injected so tests never spawn `claude`.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import { env } from "../config.ts";
import { runCheck, type CheckHost } from "./sandbox.ts";
import { parseDurationSec } from "./schedule.ts";

export type CompileRunner = (prompt: string) => Promise<string>;
export type CompiledTrigger = { summary: string; intervalSec: number; code: string };
export type CompileResult =
  | { kind: "ok"; trigger: CompiledTrigger }
  | { kind: "uncompilable"; reason: string }
  | { kind: "invalid"; error: string };

/** Trimmed prose, or null when the section means "no trigger" (missing, empty, manual, none). */
export const normaliseTriggerProse = (section: string): string | null => {
  const text = section.trim();
  if (text === "" || /^(manual|none)$/i.test(text)) return null;
  return text;
};

export const proseHash = (prose: string): string => crypto.createHash("sha256").update(prose.trim()).digest("hex");

export const buildCompilePrompt = (
  prose: string,
  opts: { execAllow: string[]; ioFloorMin: number; previousError?: string }
): string =>
  [
    "You compile a program's trigger, written in plain English, into a small JavaScript function that Gene runs on a schedule to decide whether to start the program.",
    "",
    "# Trigger",
    "",
    prose,
    "",
    "# The function",
    "",
    "Write exactly one `async function check(gene)` that returns `{ fire: boolean, reason?: string }`. It runs in a sandbox with NO other globals (no fetch, process, require, timers). Available API:",
    "",
    "- `gene.cron(expr, { tz? })` → boolean: true if the 5-field cron `expr` had a tick since the previous check. Use for any time-based schedule.",
    "- `await gene.fetch(url, { method?, headers?, body? })` → `{ status, headers, text, json() }`. http/https only, no credentials are added — use it only for public or unauthenticated endpoints.",
    opts.execAllow.length > 0
      ? `- \`await gene.exec(cmd, args)\` → \`{ code, stdout, stderr }\`. No shell (no pipes, no $()). ONLY commands starting with one of: ${opts.execAllow.map(a => `\`${a}\``).join(", ")}. Prefer these CLIs for anything that needs authentication; they are already logged in. \`glab api\` is read-only (no -X/--method/-f/-F).`
      : "- `gene.exec` is not available (no commands are allowed). Use only `gene.cron` and `gene.fetch`.",
    "- `gene.state`: a JSON object kept between runs (≤ 16 KB) — e.g. to remember what you already reported.",
    "- `gene.now()` → ISO timestamp; `gene.log(msg)` for debugging.",
    "",
    "At most 10 fetch/exec calls per run; 1 s of CPU.",
    "",
    "# Rules",
    "",
    "- Put the specifics in `reason` (which merge requests, which apps, what changed) — it is handed to the program run.",
    "- If the trigger's condition needs human-like judgment (e.g. \"when anything needs fixing\") and cannot be checked cheaply, fall back to a schedule: use the schedule in the text if there is one, else daily at 08:00, and say so in SUMMARY (e.g. \"Daily 08:00 — condition needs judgment; the run checks it\").",
    "- Only if there is no workable schedule either, answer with a single line `UNCOMPILABLE: <why>` and nothing else.",
    `- INTERVAL is how often the check should run: \`1m\` for pure cron checks; for checks that call fetch/exec at least \`${opts.ioFloorMin}m\`, matching the urgency in the text.`,
    "",
    "# Reply format (exactly this, nothing else)",
    "",
    "SUMMARY: <one line plain English, e.g. \"Weekdays at 09:00 Europe/Berlin\">",
    "INTERVAL: <e.g. 1m | 15m | 1h>",
    "```js",
    "async function check(gene) { ... }",
    "```",
    ...(opts.previousError
      ? ["", "# Your previous answer was rejected", "", opts.previousError, "", "Fix it and answer again in the same format."]
      : [])
  ].join("\n");

export const parseCompileReply = (text: string): CompileResult => {
  const unc = /^\s*UNCOMPILABLE:\s*(.+)$/m.exec(text);
  if (unc && !/```/.test(text)) return { kind: "uncompilable", reason: unc[1]!.trim() };
  const summary = /^\s*SUMMARY:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const intervalText = /^\s*INTERVAL:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const code = /```(?:js|javascript)?\s*\n([\s\S]*?)```/.exec(text)?.[1]?.trim();
  if (!summary) return { kind: "invalid", error: "reply has no SUMMARY line" };
  if (!intervalText) return { kind: "invalid", error: "reply has no INTERVAL line" };
  const intervalSec = parseDurationSec(intervalText);
  if (intervalSec === undefined) return { kind: "invalid", error: `INTERVAL "${intervalText}" is not like 1m / 15m / 1h` };
  if (!code) return { kind: "invalid", error: "reply has no ```js code block" };
  return { kind: "ok", trigger: { summary, intervalSec, code } };
};

const STUB_HOST: CheckHost = {
  cron: () => false,
  fetch: async () => ({ status: 200, headers: {}, text: "{}" }),
  exec: async () => ({ code: 0, stdout: "[]", stderr: "" }),
  now: () => new Date()
};

/** undefined when the code loads and behaves; otherwise the error to feed back. A throw on stub data is tolerated. */
export const validateCode = async (code: string): Promise<string | undefined> => {
  const out = await runCheck(code, STUB_HOST, null);
  if (out.ok || out.thrown) return undefined;
  return out.error;
};

export const compileTrigger = async (
  prose: string,
  runner: CompileRunner,
  opts: { execAllow: string[]; ioFloorMin: number }
): Promise<CompileResult> => {
  let previousError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await runner(buildCompilePrompt(prose, { ...opts, previousError }));
    } catch (error) {
      return { kind: "invalid", error: `compile run failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const parsed = parseCompileReply(text);
    if (parsed.kind === "uncompilable") return parsed;
    if (parsed.kind === "invalid") {
      previousError = parsed.error;
      continue;
    }
    const problem = await validateCode(parsed.trigger.code);
    if (problem === undefined) return parsed;
    previousError = problem;
  }
  return { kind: "invalid", error: previousError ?? "compile failed" };
};

/** The real runner: a tool-less, MCP-less, non-persisted `claude -p` with plain-text output. */
export const claudeRunner =
  (model: string): CompileRunner =>
  prompt =>
    new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      if (!env.CLAUDE_API_BILLING) delete childEnv.ANTHROPIC_API_KEY;
      execFile(
        env.CLAUDE_BIN,
        ["-p", prompt, "--model", model, "--output-format", "text", "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
        { cwd: os.tmpdir(), env: childEnv, timeout: 120_000, maxBuffer: 1024 * 1024, encoding: "utf-8" },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}${stderr ? `: ${String(stderr).slice(0, 300)}` : ""}`));
          else resolve(String(stdout));
        }
      );
    });
```

- [ ] **Step 4: Run tests**

Run: `node --test src/trigger/compile.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trigger/compile.ts src/trigger/compile.test.ts
git commit -m "feat(trigger): compile trigger prose to a validated sandbox check"
```

---

### Task 7: Trigger scanner + daemon wiring

**Files:**
- Create: `src/trigger/index.ts`
- Modify: `src/index.ts` (`scanPrograms` start; construct the scanner once)
- Modify: `src/logger.ts` (add `trigger` tag to the `Logger.tag` type and the instance)
- Test: `src/trigger/index.test.ts`

**Interfaces:**
- Consumes: `TriggerStore`, `TriggerRow` (Task 2); `runCheck`, `CheckOutcome` (Task 3); `createHost` (Task 4); `decideTrigger`, `effectiveIntervalMs` (Task 5); `compileTrigger`, `normaliseTriggerProse`, `proseHash`, `CompileResult` (Task 6); `extractProgramSections` (`src/programs.ts`)
- Produces:

```ts
export type TriggerView = {
  status: "ok" | "uncompilable" | "invalid" | "compiling";
  summary?: string; code?: string; error?: string;
  nextCheckAt?: number; lastCheckAt?: number; lastOutcome?: string; lastReason?: string;
  intervalSec?: number;
};
export type TriggerDeps = {
  trackerName: string;
  store: TriggerStore;
  now: () => Date;
  isResting: (program: Issue) => boolean;
  lastFiredAt: (program: Issue) => Promise<Date | undefined>;
  fire: (program: Issue, reason: string | undefined) => void;
  record: (program: Issue, event: string, detail: string, data?: unknown) => Promise<void>;
  comment: (program: Issue, body: string) => Promise<void>;
  compile: (prose: string) => Promise<CompileResult>;
  check: (code: string, state: unknown, windowStart: Date, now: Date) => Promise<CheckOutcome>;
  publish: (identifier: string, view: TriggerView | undefined) => void;
  cfg: { dryRun: boolean; cooldownMs: number; pollMs: number; ioFloorMs: number };
};
export type TriggerScanner = { scan(programs: Issue[]): Promise<void>; idle(): Promise<void> };
export const createTriggerScanner: (deps: TriggerDeps) => TriggerScanner;
```

Behaviour of `scan` per program (each program wrapped in try/catch → `logger.warn`, never throws):
1. `prose = normaliseTriggerProse(extractProgramSections(description).trigger)`. If `null`: if a row exists, `store.remove`; `publish(id, undefined)`; continue.
2. `hash = proseHash(prose)`; `row = store.read`. If `!row || row.proseHash !== hash`: if not already compiling, enqueue compile `{ program, prose, hash }`; `publish(id, { status: "compiling" })`; continue.
3. If `row.status !== "ok"`: publish `{ status: row.status, error: row.compileError }`; continue.
4. `gate = decideTrigger({ now, nextCheckAt: row.nextCheckAt, resting: isResting(p), lastFiredAt: await lastFiredAt(p), cooldownMs })`.
   - `not-due`: publish view from row; continue.
   - `skip`: `next = now + effectiveIntervalMs({intervalSec,usedIo,errorStreak, pollMs, ioFloorMs})`; `store.recordCheck({ lastCheckAt: now, nextCheckAt: next, lastOutcome: "skipped:" + reason })`; publish; continue.
   - `run`: `out = await check(row.code!, row.state, row.lastCheckAt ?? row.compiledAt, now)`.
     - `out.ok`: `streak = 0`; `next = now + effectiveIntervalMs({ ..., usedIo: out.usedIo, errorStreak: 0 })`; `recordCheck({ lastCheckAt: now, nextCheckAt: next, lastOutcome: out.fire ? "fire" : "no-fire", lastReason: out.reason, usedIo: out.usedIo, errorStreak: 0, errorCommented: false, state: out.state })`. If `out.fire`: dry-run ⇒ `logger.info("would fire")` + `record(p, "trigger-fired", "(would fire) " + reason)`; else `fire(p, out.reason)` + `record(p, "trigger-fired", reason ?? "condition met", { reason, logs: out.logs })`. No-fire ⇒ `logger.verbose` only.
     - `!out.ok`: `streak = row.errorStreak + 1`; `next = now + effectiveIntervalMs({ ..., usedIo: out.usedIo, errorStreak: streak })`; `record(p, "trigger-error", out.error, { logs: out.logs })`; if `streak >= 3 && !row.errorCommented && !dryRun` ⇒ `comment(p, "⚠️ Trigger check failing: " + out.error)` and `errorCommented = true`; `recordCheck({ ..., lastOutcome: "error", lastReason: out.error, usedIo: out.usedIo, errorStreak: streak, errorCommented })`.
   - publish the updated view.

Compile worker (single, sequential, background): for each job, `result = await compile(prose)`; then **re-read the latest prose hash for that identifier from the most recent `scan` input** (kept in a `Map<identifier, hash>` updated every scan) and drop the result if it no longer matches (Review Focus #1). Otherwise:
- `ok` ⇒ `store.saveCompiled({ status: "ok", summary, code, intervalSec, proseHash: hash, ... }, now())`; `record(p, "trigger-compiled", summary, { code, intervalSec })`.
- `uncompilable`/`invalid` ⇒ `store.saveCompiled({ status: kind, compileError: reason|error, proseHash: hash }, now())`; `record(p, "trigger-" + kind, msg)`; unless dryRun, `comment(p, "⚠️ Couldn't compile the trigger: " + msg + " — edit ## Trigger to retry")`. One comment per hash follows from the row now matching the hash.
`idle()` resolves when the queue is empty (tests use it).

- [ ] **Step 1: Write failing tests** — `src/trigger/index.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Issue } from "../tracker/index.ts";
import type { TriggerStore, TriggerRow, CompiledFields, CheckUpdate } from "./store.ts";
import type { CompileResult } from "./compile.ts";
import type { CheckOutcome } from "./sandbox.ts";
import { createTriggerScanner, type TriggerDeps } from "./index.ts";

const program = (identifier: string, trigger: string, stateName = "Todo"): Issue =>
  ({ id: `id-${identifier}`, identifier, title: identifier, description: `## Trigger\n${trigger}\n\n## Workflow\nx\n\n## Acceptance criteria\ny`, stateName } as unknown as Issue);

const memoryStore = (): TriggerStore & { rows: Map<string, TriggerRow> } => {
  const rows = new Map<string, TriggerRow>();
  return {
    rows,
    read: async (_t, id) => rows.get(id) ?? null,
    saveCompiled: async (f: CompiledFields, now: Date) => {
      rows.set(f.identifier, { ...f, compiledAt: now, lastCheckAt: now, nextCheckAt: now, usedIo: false, errorStreak: 0, errorCommented: false, state: null });
    },
    recordCheck: async (_t, id, u: CheckUpdate) => {
      const r = rows.get(id)!;
      rows.set(id, {
        ...r,
        lastCheckAt: u.lastCheckAt, nextCheckAt: u.nextCheckAt, lastOutcome: u.lastOutcome, lastReason: u.lastReason,
        usedIo: u.usedIo ?? r.usedIo, errorStreak: u.errorStreak ?? r.errorStreak,
        errorCommented: u.errorCommented ?? r.errorCommented, state: u.state !== undefined ? u.state : r.state
      });
    },
    remove: async (_t, id) => void rows.delete(id)
  };
};

const harness = (over: Partial<TriggerDeps> = {}) => {
  let clock = new Date("2026-10-07T09:00:00Z");
  const fires: [string, string | undefined][] = [];
  const comments: string[] = [];
  const events: string[] = [];
  const store = memoryStore();
  const deps: TriggerDeps = {
    trackerName: "linear",
    store,
    now: () => clock,
    isResting: p => p.stateName === "Todo",
    lastFiredAt: async () => undefined,
    fire: (p, reason) => fires.push([p.identifier, reason]),
    record: async (_p, event) => void events.push(event),
    comment: async (_p, body) => void comments.push(body),
    compile: async (): Promise<CompileResult> => ({ kind: "ok", trigger: { summary: "always", intervalSec: 60, code: "c" } }),
    check: async (): Promise<CheckOutcome> => ({ ok: true, fire: true, reason: "because", state: null, logs: [], usedIo: false }),
    publish: () => {},
    cfg: { dryRun: false, cooldownMs: 30 * 60_000, pollMs: 60_000, ioFloorMs: 5 * 60_000 },
    ...over
  };
  const scanner = createTriggerScanner(deps);
  return { scanner, deps, store, fires, comments, events, tick: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
};

test("new prose compiles in the background, then a due check fires once", async () => {
  const h = harness();
  const p = program("PRG-1", "every hour");
  await h.scanner.scan([p]);
  assert.deepEqual(h.fires, []);
  await h.scanner.idle();
  assert.deepEqual(h.events, ["trigger-compiled"]);
  await h.scanner.scan([p]);
  assert.deepEqual(h.fires, [["PRG-1", "because"]]);
  await h.scanner.scan([p]); // not due yet (next = now + 60s)
  assert.equal(h.fires.length, 1);
});

test("busy and cooldown skip the check without running it", async () => {
  let checks = 0;
  const h = harness({ check: async () => (checks++, { ok: true, fire: true, state: null, logs: [], usedIo: false }) });
  await h.scanner.scan([program("PRG-2", "every hour")]);
  await h.scanner.idle();
  await h.scanner.scan([program("PRG-2", "every hour", "In Progress")]);
  assert.equal(checks, 0);
  assert.equal(h.store.rows.get("PRG-2")?.lastOutcome, "skipped:busy");

  const h2 = harness({ lastFiredAt: async () => new Date("2026-10-07T08:50:00Z") });
  await h2.scanner.scan([program("PRG-3", "every hour")]);
  await h2.scanner.idle();
  await h2.scanner.scan([program("PRG-3", "every hour")]);
  assert.deepEqual(h2.fires, []);
  assert.equal(h2.store.rows.get("PRG-3")?.lastOutcome, "skipped:cooldown");
});

test("uncompilable posts one comment per prose hash", async () => {
  const h = harness({ compile: async () => ({ kind: "uncompilable", reason: "no schedule" }) });
  const p = program("PRG-4", "vibes");
  await h.scanner.scan([p]);
  await h.scanner.idle();
  await h.scanner.scan([p]);
  await h.scanner.idle();
  assert.equal(h.comments.length, 1);
  assert.match(h.comments[0]!, /Couldn't compile the trigger: no schedule/);
});

test("three consecutive check errors post one comment; success resets", async () => {
  let fail = true;
  const h = harness({
    check: async () => (fail ? { ok: false, error: "boom", thrown: true, logs: [], usedIo: false } : { ok: true, fire: false, state: null, logs: [], usedIo: false })
  });
  const p = program("PRG-5", "every hour");
  await h.scanner.scan([p]);
  await h.scanner.idle();
  for (let i = 0; i < 5; i++) {
    await h.scanner.scan([p]);
    h.tick(2 * 60 * 60_000);
  }
  assert.equal(h.comments.length, 1);
  assert.match(h.comments[0]!, /Trigger check failing: boom/);
  fail = false;
  await h.scanner.scan([p]);
  assert.equal(h.store.rows.get("PRG-5")?.errorStreak, 0);
});

test("prose changed while compiling: stale result discarded", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const compiled: string[] = [];
  const h = harness({
    compile: async prose => {
      if (prose === "every hour") await gate;
      compiled.push(prose);
      return { kind: "ok", trigger: { summary: prose, intervalSec: 60, code: "c" } };
    }
  });
  await h.scanner.scan([program("PRG-6", "every hour")]);
  await h.scanner.scan([program("PRG-6", "every day")]);
  release();
  await h.scanner.idle();
  await h.scanner.scan([program("PRG-6", "every day")]);
  await h.scanner.idle();
  assert.equal(h.store.rows.get("PRG-6")?.summary, "every day");
});

test("manual removes the trigger row", async () => {
  const h = harness();
  await h.scanner.scan([program("PRG-7", "every hour")]);
  await h.scanner.idle();
  await h.scanner.scan([program("PRG-7", "manual")]);
  assert.equal(h.store.rows.has("PRG-7"), false);
});

test("dry run logs but does not fire or comment", async () => {
  const h = harness({ cfg: { dryRun: true, cooldownMs: 0, pollMs: 60_000, ioFloorMs: 300_000 } });
  await h.scanner.scan([program("PRG-8", "every hour")]);
  await h.scanner.idle();
  await h.scanner.scan([program("PRG-8", "every hour")]);
  assert.deepEqual(h.fires, []);
  assert.ok(h.events.includes("trigger-fired"));
});

test("a store failure for one program does not stop the others", async () => {
  const h = harness();
  const read = h.store.read;
  h.store.read = async (t, id) => (id === "BAD" ? Promise.reject(new Error("db down")) : read(t, id));
  await h.scanner.scan([program("BAD", "every hour"), program("PRG-9", "every hour")]);
  await h.scanner.idle();
  await h.scanner.scan([program("BAD", "every hour"), program("PRG-9", "every hour")]);
  assert.deepEqual(h.fires, [["PRG-9", "because"]]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/trigger/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/trigger/index.ts`**

```ts
/**
 * The trigger scanner: per program, keep its compiled check in step with the `## Trigger`
 * prose (background compile on change), then run due checks behind the busy/cooldown
 * gates and fire through the injected `fire` hook. Daemon specifics (tracker, store,
 * monitor, the fire queue) arrive as {@link TriggerDeps} so this is testable in isolation.
 */
import logger from "../logger.ts";
import type { Issue } from "../tracker/index.ts";
import { extractProgramSections } from "../programs.ts";
import { normaliseTriggerProse, proseHash, type CompileResult } from "./compile.ts";
import type { CheckOutcome } from "./sandbox.ts";
import { decideTrigger, effectiveIntervalMs } from "./schedule.ts";
import type { TriggerRow, TriggerStore } from "./store.ts";

const ERROR_COMMENT_STREAK = 3;

export type TriggerView = {
  status: "ok" | "uncompilable" | "invalid" | "compiling";
  summary?: string;
  code?: string;
  error?: string;
  nextCheckAt?: number;
  lastCheckAt?: number;
  lastOutcome?: string;
  lastReason?: string;
  intervalSec?: number;
};

export type TriggerDeps = {
  trackerName: string;
  store: TriggerStore;
  now: () => Date;
  isResting: (program: Issue) => boolean;
  lastFiredAt: (program: Issue) => Promise<Date | undefined>;
  fire: (program: Issue, reason: string | undefined) => void;
  record: (program: Issue, event: string, detail: string, data?: unknown) => Promise<void>;
  comment: (program: Issue, body: string) => Promise<void>;
  compile: (prose: string) => Promise<CompileResult>;
  check: (code: string, state: unknown, windowStart: Date, now: Date) => Promise<CheckOutcome>;
  publish: (identifier: string, view: TriggerView | undefined) => void;
  cfg: { dryRun: boolean; cooldownMs: number; pollMs: number; ioFloorMs: number };
};

export type TriggerScanner = { scan(programs: Issue[]): Promise<void>; idle(): Promise<void> };

const viewOf = (row: TriggerRow): TriggerView => ({
  status: row.status,
  summary: row.summary,
  code: row.code,
  error: row.status === "ok" ? (row.lastOutcome === "error" ? row.lastReason : undefined) : row.compileError,
  nextCheckAt: row.nextCheckAt?.getTime(),
  lastCheckAt: row.lastCheckAt?.getTime(),
  lastOutcome: row.lastOutcome,
  lastReason: row.lastReason,
  intervalSec: row.intervalSec
});

export const createTriggerScanner = (deps: TriggerDeps): TriggerScanner => {
  const latestHash = new Map<string, string>();
  const compiling = new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  const interval = (row: TriggerRow, usedIo: boolean, errorStreak: number): number =>
    effectiveIntervalMs({ intervalSec: row.intervalSec, usedIo, errorStreak, pollMs: deps.cfg.pollMs, ioFloorMs: deps.cfg.ioFloorMs });

  const enqueueCompile = (program: Issue, prose: string, hash: string): void => {
    const key = `${program.identifier}:${hash}`;
    if (compiling.has(key)) return;
    compiling.add(key);
    queue = queue.then(async () => {
      try {
        const result = await deps.compile(prose);
        if (latestHash.get(program.identifier) !== hash) return; // prose moved on — drop the stale result
        const base = { tracker: deps.trackerName, identifier: program.identifier, proseHash: hash };
        if (result.kind === "ok") {
          const { summary, code, intervalSec } = result.trigger;
          await deps.store.saveCompiled({ ...base, status: "ok", summary, code, intervalSec }, deps.now());
          await deps.record(program, "trigger-compiled", summary, { code, intervalSec });
          logger.info(`${logger.tag.trigger} [${program.identifier}] compiled: ${summary}`);
        } else {
          const message = result.kind === "uncompilable" ? result.reason : result.error;
          await deps.store.saveCompiled({ ...base, status: result.kind, compileError: message }, deps.now());
          await deps.record(program, `trigger-${result.kind}`, message);
          logger.warn(`${logger.tag.trigger} [${program.identifier}] trigger not compiled: ${message}`);
          if (!deps.cfg.dryRun) {
            await deps.comment(program, `⚠️ Couldn't compile the trigger: ${message} — edit \`## Trigger\` to retry.`);
          }
        }
      } catch (error) {
        logger.warn(`${logger.tag.trigger} [${program.identifier}] compile failed:`, error instanceof Error ? error.message : error);
      } finally {
        compiling.delete(key);
      }
    });
  };

  const scanOne = async (program: Issue): Promise<void> => {
    const id = program.identifier;
    const prose = normaliseTriggerProse(extractProgramSections(program.description ?? "").trigger);
    if (prose === null) {
      latestHash.delete(id);
      if (await deps.store.read(deps.trackerName, id)) await deps.store.remove(deps.trackerName, id);
      deps.publish(id, undefined);
      return;
    }
    const hash = proseHash(prose);
    latestHash.set(id, hash);
    const row = await deps.store.read(deps.trackerName, id);
    if (!row || row.proseHash !== hash) {
      enqueueCompile(program, prose, hash);
      deps.publish(id, { status: "compiling" });
      return;
    }
    if (row.status !== "ok" || !row.code) {
      deps.publish(id, viewOf(row));
      return;
    }

    const now = deps.now();
    const gate = decideTrigger({
      now,
      nextCheckAt: row.nextCheckAt,
      resting: deps.isResting(program),
      lastFiredAt: await deps.lastFiredAt(program),
      cooldownMs: deps.cfg.cooldownMs
    });
    if (gate.kind === "not-due") {
      deps.publish(id, viewOf(row));
      return;
    }
    if (gate.kind === "skip") {
      await deps.store.recordCheck(deps.trackerName, id, {
        lastCheckAt: now,
        nextCheckAt: new Date(now.getTime() + interval(row, row.usedIo, row.errorStreak)),
        lastOutcome: `skipped:${gate.reason}`
      });
    } else {
      const out = await deps.check(row.code, row.state, row.lastCheckAt ?? row.compiledAt, now);
      if (out.ok) {
        await deps.store.recordCheck(deps.trackerName, id, {
          lastCheckAt: now,
          nextCheckAt: new Date(now.getTime() + interval(row, out.usedIo, 0)),
          lastOutcome: out.fire ? "fire" : "no-fire",
          lastReason: out.reason,
          usedIo: out.usedIo,
          errorStreak: 0,
          errorCommented: false,
          state: out.state
        });
        if (out.fire) {
          const reason = out.reason ?? "trigger condition met";
          if (deps.cfg.dryRun) {
            logger.info(`${logger.tag.trigger} [${id}] would fire (${reason})`);
            await deps.record(program, "trigger-fired", `(would fire) ${reason}`, { reason, logs: out.logs });
          } else {
            logger.info(`${logger.tag.trigger} [${id}] firing: ${reason}`);
            deps.fire(program, out.reason);
            await deps.record(program, "trigger-fired", reason, { reason, logs: out.logs });
          }
        } else {
          logger.verbose(`${logger.tag.trigger} [${id}] no fire${out.reason ? ` (${out.reason})` : ""}`);
        }
      } else {
        const streak = row.errorStreak + 1;
        let commented = row.errorCommented;
        await deps.record(program, "trigger-error", out.error, { logs: out.logs });
        logger.warn(`${logger.tag.trigger} [${id}] check failed (${streak}×): ${out.error}`);
        if (streak >= ERROR_COMMENT_STREAK && !commented && !deps.cfg.dryRun) {
          await deps.comment(program, `⚠️ Trigger check failing: ${out.error}`);
          commented = true;
        }
        await deps.store.recordCheck(deps.trackerName, id, {
          lastCheckAt: now,
          nextCheckAt: new Date(now.getTime() + interval(row, out.usedIo, streak)),
          lastOutcome: "error",
          lastReason: out.error,
          usedIo: out.usedIo,
          errorStreak: streak,
          errorCommented: commented
        });
      }
    }
    const updated = await deps.store.read(deps.trackerName, id);
    deps.publish(id, updated ? viewOf(updated) : undefined);
  };

  return {
    scan: async programs => {
      for (const program of programs) {
        try {
          await scanOne(program);
        } catch (error) {
          logger.warn(`${logger.tag.trigger} [${program.identifier}] trigger scan failed:`, error instanceof Error ? error.message : error);
        }
      }
    },
    idle: async () => {
      // Drain: a job may enqueue nothing further, but loop in case scans raced in more.
      let current: Promise<void>;
      do {
        current = queue;
        await current;
      } while (current !== queue);
    }
  };
};
```

`src/logger.ts`: add `trigger: string;` to the `tag` type and `trigger: chalk.magentaBright("[gene:trigger]"),` to the instance.

`src/index.ts` — construct once near the other module-level daemon state (after `record` is defined):

```ts
const triggerScanner = createTriggerScanner({
  trackerName: tracker.name,
  store: dbTriggerStore,
  now: () => new Date(),
  isResting: p =>
    p.stateName !== env.ACTIVE_STATE &&
    p.stateName !== env.BLOCKED_STATE &&
    !inFlight.has(p.id) &&
    !hasFireRequest(p.identifier),
  lastFiredAt: async p => {
    const st = await readProgramState(tracker.name, p.identifier);
    return st?.lastFiredAt ? new Date(st.lastFiredAt) : undefined;
  },
  fire: (p, reason) => fireProgram(p.identifier, "trigger", reason),
  record,
  comment: (p, body) => tracker.postComment(p, body),
  compile: prose =>
    compileTrigger(prose, claudeRunner(env.TRIGGER_COMPILE_MODEL), {
      execAllow: env.TRIGGER_EXEC_ALLOW,
      ioFloorMin: env.TRIGGER_IO_MIN_INTERVAL_MIN
    }),
  check: (code, state, windowStart, now) =>
    runCheck(code, createHost({ windowStart, now, execAllow: env.TRIGGER_EXEC_ALLOW }), state),
  publish: (id, view) => monitor.setProgramTrigger(id, view),
  cfg: {
    dryRun: env.DRY_RUN,
    cooldownMs: env.PROGRAM_TRIGGER_COOLDOWN_MIN * 60_000,
    pollMs: env.POLL_INTERVAL_MS,
    ioFloorMs: env.TRIGGER_IO_MIN_INTERVAL_MIN * 60_000
  }
});
```

(`inFlight` must be declared before this; if it is declared later in the file, place this block after it. `monitor.setProgramTrigger` arrives in Task 8 — until then, add a stub method `setProgramTrigger(_id: string, _view: unknown): void {}` to `Monitor` so this task typechecks, and replace it in Task 8.)

At the top of `scanPrograms`, before the `for` loop:

```ts
  // Triggers first, so a fire they enqueue is dispatched by the loop below in this same scan.
  if (env.PROGRAM_TRIGGERS) {
    await triggerScanner.scan(programs.filter(p => tracker.isAssignedToOwner(p)));
  }
```

Imports in `src/index.ts`: `createTriggerScanner` from `./trigger/index.ts`, `dbTriggerStore` from `./trigger/store.ts`, `compileTrigger, claudeRunner` from `./trigger/compile.ts`, `runCheck` from `./trigger/sandbox.ts`, `createHost` from `./trigger/host.ts`.

- [ ] **Step 4: Run tests + full suite**

Run: `node --test src/trigger/index.test.ts && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trigger/index.ts src/trigger/index.test.ts src/index.ts src/logger.ts src/monitor.ts
git commit -m "feat(trigger): scanner — background compile, gated checks, fire via the program queue"
```

---

### Task 8: TUI — ⚡ glyph, status line, `t` toggles code

**Files:**
- Modify: `src/monitor.ts` (`AgentState.trigger`, `setProgramTrigger`)
- Modify: `src/ui/theme.ts` (`TRIGGER_GLYPH`)
- Modify: `src/ui/dashboard.ts:155-158` (lead cell)
- Modify: `src/ui/detail.ts` (trigger line + code toggle + footer hint)
- Modify: `src/ui/app.ts` (detail-view `t` key)
- Test: `src/ui/dashboard.test.ts`, `src/ui/theme.test.ts`, `src/ui/trigger-line.test.ts`

**Interfaces:**
- Consumes: `TriggerView` (Task 7)
- Produces:
  - `AgentState.trigger?: TriggerView`
  - `Monitor.setProgramTrigger(id: string, view: TriggerView | undefined): void`
  - `TRIGGER_GLYPH = "⚡"`
  - `programLeadGlyph(a: AgentState): { glyph: string; warn: boolean }` (exported from `dashboard.ts`)
  - `formatTriggerLine(view: TriggerView, now: number): string` (exported from `src/ui/trigger-line.ts`)

- [ ] **Step 1: Write failing tests**

`src/ui/theme.test.ts` — add:

```ts
test("trigger glyph is a lightning bolt", () => {
  assert.equal(TRIGGER_GLYPH, "⚡");
});
```

(import `TRIGGER_GLYPH` alongside `PROGRAM_GLYPH`.)

`src/ui/dashboard.test.ts` — add (reuse the file's `agent` factory):

```ts
test("programLeadGlyph: ⚡ for an ok trigger, ⟳ otherwise, warn on failure", () => {
  const p = agent("PRG-1", true);
  assert.deepEqual(programLeadGlyph(p), { glyph: "⟳", warn: false });
  assert.deepEqual(programLeadGlyph({ ...p, trigger: { status: "ok" } }), { glyph: "⚡", warn: false });
  assert.deepEqual(programLeadGlyph({ ...p, trigger: { status: "ok", lastOutcome: "error" } }), { glyph: "⚡", warn: true });
  assert.deepEqual(programLeadGlyph({ ...p, trigger: { status: "invalid" } }), { glyph: "⟳", warn: true });
  assert.deepEqual(programLeadGlyph({ ...p, trigger: { status: "compiling" } }), { glyph: "⟳", warn: false });
});
```

`src/ui/trigger-line.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTriggerLine } from "./trigger-line.ts";

const now = Date.parse("2026-10-07T08:59:30Z");

test("ok trigger line", () => {
  const line = formatTriggerLine(
    { status: "ok", summary: "Hourly", intervalSec: 60, nextCheckAt: now + 30_000, lastCheckAt: now - 30_000, lastOutcome: "no-fire" },
    now
  );
  assert.match(line, /^⚡ Hourly · every 1m · next in 30s · last: no fire/);
});

test("compiling / uncompilable / error lines", () => {
  assert.equal(formatTriggerLine({ status: "compiling" }, now), "⟳ compiling trigger…");
  assert.equal(formatTriggerLine({ status: "uncompilable", error: "no schedule" }, now), "⚠ trigger not compiled: no schedule");
  assert.match(formatTriggerLine({ status: "ok", summary: "Hourly", lastOutcome: "error", lastReason: "boom" }, now), /last: error — boom/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/ui/theme.test.ts src/ui/dashboard.test.ts src/ui/trigger-line.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/ui/theme.ts`, next to `PROGRAM_GLYPH`:

```ts
/** Lead glyph for a program whose `## Trigger` compiled to an active automatic check. */
export const TRIGGER_GLYPH = "⚡";
```

`src/monitor.ts`: in `AgentState` add

```ts
  /** The program's compiled trigger status (programs with GENE_PROGRAM_TRIGGERS on). */
  trigger?: TriggerView;
```

(`import type { TriggerView } from "./trigger/index.ts";`) and replace the Task 7 stub with:

```ts
  /** Attach (or clear) a program row's trigger status for the dashboard glyph and detail line. */
  setProgramTrigger(id: string, view: TriggerView | undefined): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.trigger = view;
    this.scheduleChange();
  }
```

`src/ui/dashboard.ts`: export

```ts
/** Lead cell for a program row: ⚡ when its trigger is armed, else ⟳; warn when the trigger is failing. */
export const programLeadGlyph = (a: AgentState): { glyph: string; warn: boolean } => {
  const t = a.trigger;
  const warn = !!t && (t.status === "uncompilable" || t.status === "invalid" || t.lastOutcome === "error");
  return { glyph: t?.status === "ok" ? TRIGGER_GLYPH : PROGRAM_GLYPH, warn };
};
```

and change the lead-cell lines to:

```ts
  const lead = a.isProgram ? programLeadGlyph(a) : undefined;
  const leadCell = fit(lead ? lead.glyph : trackerInitial, COL.tracker);
  const leadChunk = lead ? fg(lead.warn ? palette.warn : palette.accent)(leadCell) : dim(leadCell);
```

`src/ui/trigger-line.ts`:

```ts
/** One-line, plain-text trigger status for the program detail view. */
import { humanDuration } from "./format.ts";
import type { TriggerView } from "../trigger/index.ts";

const outcomeText = (v: TriggerView): string => {
  switch (v.lastOutcome) {
    case undefined:
      return "not checked yet";
    case "fire":
      return `fired${v.lastReason ? ` — ${v.lastReason}` : ""}`;
    case "no-fire":
      return "no fire";
    case "error":
      return `error — ${v.lastReason ?? "unknown"}`;
    default:
      return v.lastOutcome.replace("skipped:", "skipped (") + (v.lastOutcome.startsWith("skipped:") ? ")" : "");
  }
};

export const formatTriggerLine = (v: TriggerView, now: number): string => {
  if (v.status === "compiling") return "⟳ compiling trigger…";
  if (v.status !== "ok") return `⚠ trigger not compiled: ${v.error ?? v.status}`;
  const parts = [`⚡ ${v.summary ?? "trigger"}`];
  if (v.intervalSec) parts.push(`every ${humanDuration(v.intervalSec * 1000)}`);
  if (v.nextCheckAt) parts.push(v.nextCheckAt <= now ? "due" : `next in ${humanDuration(v.nextCheckAt - now)}`);
  parts.push(`last: ${outcomeText(v)}`);
  return parts.join(" · ");
};
```

(Check `humanDuration`'s module and output: `grep -n "export const humanDuration" src/ui/*.ts`. If its output for 60 000 ms isn't `1m` or for 30 000 ms isn't `30s`, adjust the test expectations to its real format — don't add a second formatter.)

`src/ui/detail.ts`:
- Add `private triggerLine: TextRenderable;` created like `subLine` (`id: "gene-detail-trigger"`, `flexShrink: 0`), added right after `subLine`; and `private showTriggerCode = false;`.
- Public `toggleTriggerCode(): void { this.showTriggerCode = !this.showTriggerCode; this.liveMode = "pending"; this.liveRendered = 0; this.clearLive(); }`; reset `showTriggerCode = false` in `open()`.
- In `render`, after `subLine`:

```ts
    const trig = agent?.isProgram ? agent.trigger : undefined;
    this.triggerLine.visible = !!trig;
    this.triggerLine.content = trig
      ? t`${fg(trig.status === "ok" && trig.lastOutcome !== "error" ? palette.accent : palette.warn)(formatTriggerLine(trig, now))}`
      : "";
```

- At the start of the live-pane branch chain, add a first branch:

```ts
    if (this.showTriggerCode && trig?.code) {
      if (this.liveMode !== "code") {
        this.clearLive();
        for (const line of trig.code.split("\n")) this.addLiveLine(line, palette.text);
        this.liveMode = "code";
      }
      this.liveLabel.content = this.sectionLabel("trigger code (t to close)");
    } else if (agent && agent.events.length > 0) {
```

and widen the `liveMode` union with `"code"`.
- Footer: when `trig` is set, insert `${fg(palette.muted)("t")} trigger code  ` before `esc`.

`src/ui/app.ts`, in the detail-view key switch (next to `case "c":`):

```ts
        case "t":
          // `t` toggles the program's compiled trigger code in the live pane.
          detail.toggleTriggerCode();
          paint();
          return;
```

- [ ] **Step 4: Run tests**

Run: `node --test src/ui/*.test.ts && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Manual check**

Run `GENE_PROGRAM_TRIGGERS=true GENE_DRY_RUN=true npm run gene` against the real board; open a program with `## Trigger: every hour`. Expected: ⟳ while compiling, then ⚡; detail shows `⚡ … · every 1m · next in …`; `t` shows code; the activity log gets `trigger-compiled` and, at the hour, `trigger-fired (would fire)`.

- [ ] **Step 6: Commit**

```bash
git add src/monitor.ts src/ui/theme.ts src/ui/theme.test.ts src/ui/dashboard.ts src/ui/dashboard.test.ts src/ui/trigger-line.ts src/ui/trigger-line.test.ts src/ui/detail.ts src/ui/app.ts
git commit -m "feat(tui): ⚡ for armed program triggers, trigger status line, t shows code"
```

---

### Task 9: Docs, binary build, version

**Files:**
- Modify: `README.md` (Programs section: replace "Triggers are a later phase" paragraph)
- Modify: `.gene.config.example` (new keys)
- Modify: `package.json` (version 1.4.0 via `npm version`)

- [ ] **Step 1: README** — replace the paragraph starting `**Triggers are a later phase.**` with:

```markdown
**Triggers (opt-in)** Set `GENE_PROGRAM_TRIGGERS=true` and Gene fires programs on its
own from their `## Trigger` prose. When the prose is new or changes, a short agent run
compiles it once into a small JavaScript check — "every hour" becomes a cron check,
"when one of my MRs needs a rebase" becomes a `glab api` query — cached until the prose
changes. The daemon runs due checks on its poll; when one matches, the program fires and
the check's reason (e.g. `!87, !91 need rebase`) is handed to the run. Write `manual` in
`## Trigger` to keep a program manual-only.

- **Sandboxed.** Checks run in QuickJS with no filesystem, env, or network except
  `gene.fetch` (http/https, no credentials added) and `gene.exec`, which only runs
  commands matching `GENE_TRIGGER_EXEC_ALLOW` (e.g. `glab api,argocd app list`; empty by
  default). `glab api` is forced read-only. Keep commands that print secrets (e.g.
  `bao kv get`) off the list.
- **Safety limits.** A trigger never fires a program that is already running, and waits
  `GENE_PROGRAM_TRIGGER_COOLDOWN_MIN` (default 30) after the last fire — a `g` press
  counts. Checks that call out run at most every `GENE_TRIGGER_IO_MIN_INTERVAL_MIN`
  (default 5) minutes. A condition that stays true re-fires once per cooldown until the
  run fixes it; set `## Trigger` to `manual` to silence it.
- **Visible.** Armed programs show **⚡** instead of ⟳; the detail view shows the compiled
  summary, next check and last result, and **`t`** shows the code. A trigger that can't
  be compiled, or whose check fails 3 times in a row, gets one comment on the ticket.
- Compiles use `GENE_TRIGGER_COMPILE_MODEL` (default `haiku`). `g` works exactly as before.
```

- [ ] **Step 2: `.gene.config.example`** — after the program keys, add:

```
# --- Program triggers (opt-in) -------------------------------------------------
# Fire programs automatically from their `## Trigger` prose (compiled once to a
# sandboxed check). See README "Programs".
# GENE_PROGRAM_TRIGGERS=true
# GENE_PROGRAM_TRIGGER_COOLDOWN_MIN=30
# Command prefixes a check may run (no shell). Empty = cron/URL triggers only.
# GENE_TRIGGER_EXEC_ALLOW=glab api,argocd app list,argocd app get
# GENE_TRIGGER_IO_MIN_INTERVAL_MIN=5
# GENE_TRIGGER_COMPILE_MODEL=haiku
```

- [ ] **Step 3: Build the binary and smoke-test the embedded QuickJS**

Run: `npm run build`
Expected: `./gene` built without errors.

Then, from a scratch dir, verify the SEA asset path works:

```bash
REPO="$(pwd)"; cd "$(mktemp -d)" && GENE_PROGRAM_TRIGGERS=true GENE_DRY_RUN=true "$REPO/gene" --once --headless 2>&1 | grep -i "trigger" | head
```

Expected: no `quickjs`/`wasm` load errors (compile/fire log lines if a program has a trigger). If the bundler inlined the variant's wasm loader with a broken path, the `inSea()` branch in `sandbox.ts` must be the one used — confirm `quickjs.wasm` is in `sea.json` assets.

- [ ] **Step 4: Version + full verification**

```bash
npm version minor --no-git-tag-version   # 1.3.7 → 1.4.0
npm run typecheck && npm test
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md .gene.config.example package.json package-lock.json
git commit -m "feat: program triggers — free-form ## Trigger compiled to sandboxed checks (v1.4.0)"
```
