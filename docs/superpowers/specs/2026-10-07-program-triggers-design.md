# Program triggers: free-form `## Trigger` compiled to sandboxed checks

**Date:** 2026-10-07
**Status:** draft — awaiting review
**Supersedes:** §7 "Triggers (Phase 2)" of `2026-08-16-programs-mode-design.md` (webhook
registration + inbound ingress). This design is polling-only; no inbound endpoint.

## Problem

Programs (v1.3.0) fire only manually — the `g` key in the TUI. Every program carries a
`## Trigger` section, but it is informational: nothing reads it. The programs we want to
run need automatic firing, e.g.:

| Program | Trigger as written |
|---|---|
| Logs scan (CLOUD-2629) | every hour |
| Rebase my GitLab MRs | when any of my MRs needs a rebase |
| Argo CD sync | when an app is out of sync |
| OpenBao / Argo CD config review (testing/staging/prod) | when anything needs fixing |

The trigger must stay **free-form prose** on the ticket (authors don't learn a DSL), yet
must not cost an agent run per poll.

## Approach

When a program's `## Trigger` prose is new or changed, a short agent run **compiles** it
once into a JavaScript `check(gene)` function. Gene caches the code keyed by a hash of the
prose and runs it regularly in a **QuickJS sandbox** whose only capabilities are host
functions Gene provides (`cron`, `fetch`, allowlisted `exec`, persisted `state`). When a
check returns `fire: true`, the program fires through the existing
`fireProgram(id, "trigger")` path, subject to a cooldown and a never-while-running rule.

The prose comes from the tracker, so the compiled code is treated as **untrusted**: the
sandbox, not the compiler prompt, is the security boundary.

Mapping the examples:

| Program | Compiled check (sketch) |
|---|---|
| Logs scan, hourly | `return { fire: gene.cron("0 * * * *") }` |
| Rebase MRs | `glab api "merge_requests?scope=created_by_me&state=opened"` → fire if any `detailed_merge_status == "need_rebase"`, reason `"!87, !91 need rebase"` |
| Argo CD sync | `argocd app list -o json` → fire if any app `OutOfSync`, reason lists the apps |
| Config review | condition needs judgment → schedule fallback, e.g. `gene.cron("0 8 * * *")`; the run itself does the review |

## 1. Compile: prose → cached check

**When.** Each program scan (only when `GENE_PROGRAM_TRIGGERS=true`) computes
`sha256(trim(## Trigger body))`:

- section missing, empty, or exactly `manual` / `none` (case-insensitive) → no trigger;
  `g` only. Any stored trigger row is deleted.
- hash equals the stored `prose_hash` → use the cached row (whatever its status).
- otherwise → enqueue a compile. Compiles run **one at a time** in the background and never
  block the scan; a program with a pending compile does not run a check.

**How.** A dedicated `claude -p` invocation (not a program run, no worktree, **no tools**),
model `GENE_TRIGGER_COMPILE_MODEL` (default `haiku`). The prompt contains the trigger
prose, the `gene` API reference (§2), the currently allowed exec prefixes
(`GENE_TRIGGER_EXEC_ALLOW`), the IO interval floor, and the reply format:

````
SUMMARY: <one line, plain English, e.g. "Weekdays at 09:00 Europe/Berlin">
INTERVAL: <duration, e.g. 1m | 15m | 1h>
```js
async function check(gene) { ... return { fire, reason }; }
```
````

or a single line `UNCOMPILABLE: <why>`.

Compiler rules stated in the prompt:

- Use only the `gene` API; use `exec` only with an allowed prefix.
- A condition that needs **judgment** (e.g. "anything needs fixing") compiles to a
  **schedule fallback** — the schedule from the prose if given, else daily 08:00 — and the
  SUMMARY says so ("Daily 08:00 — condition needs judgment; the run checks it").
  `UNCOMPILABLE` only when no workable schedule exists either.
- Put the specifics in `reason` (which MRs, which apps) — it is passed to the run.

**Validation before caching.** Parse the reply; load the code in a fresh sandbox; assert
`check` is a function; do one **dry invocation** with stub host functions (`fetch` →
`{status: 200, text: "{}"}`, `exec` → `{code: 0, stdout: "[]", stderr: ""}`, `cron` →
`false`). A syntax error, a missing `check`, a limit breach, or a *returned* value of the
wrong shape fails validation. A **throw** during the dry invocation does not — stub data
can't stand in for real API output, so a runtime error there is inconclusive. On any
failure, retry the compile **once** with the error appended to the prompt.

**Failure** (UNCOMPILABLE, or still invalid after the retry): store `status =
uncompilable | invalid` with `compile_error` for this hash. No automatic firing; `g` still
works. Post **one** ticket comment per hash:
`⚠️ Couldn't compile the trigger: <reason> — edit ## Trigger to retry` + `#gene-ai` marker.
No further attempts until the prose changes.

**Success:** store the row (`status = ok`), reset `state`, set the cron window start to
now (§3), log `trigger-compiled` (summary + code). No ticket comment.

## 2. Runtime and sandbox

**Engine.** `quickjs-emscripten` 0.32, sync **release** WASM variant
(`@jitl/quickjs-wasmfile-release-sync`), embedded in the SEA binary as an asset the same
way `pglite.wasm` is (`src/sea-assets.ts`, `sea.json`, `build.mjs`). Host functions return
promises (`ctx.newPromise` + `runtime.executePendingJobs`), so generated code is
`async function check(gene)`. Not the asyncify variant (slower, larger).

**Isolation.** A fresh QuickJS runtime + context per check run, disposed after. The global
scope exposes only the `gene` object — no `process`, `require`, filesystem, env, timers.

**The `gene` API**

| Member | Returns | Rules |
|---|---|---|
| `gene.cron(expr, { tz? })` | `boolean` — a scheduled tick fell in `(window_start, now]` | `cron-parser`; window semantics in §3 |
| `await gene.fetch(url, { method?, headers?, body? })` | `{ status, headers, text, json() }` | `http:`/`https:` only; 10 s timeout; body truncated at 1 MB; Gene adds no credentials |
| `await gene.exec(cmd, args)` | `{ code, stdout, stderr }` | `cmd + " " + args.join(" ")` must start with an entry of `GENE_TRIGGER_EXEC_ALLOW`; `execFile` (no shell); 20 s timeout; stdout/stderr truncated at 1 MB each; cwd = a fresh temp dir; inherits Gene's env so CLIs find their auth |
| `gene.state` | plain object, read/write | persisted after the run; must be JSON-serialisable and ≤ 16 KB |
| `gene.now()` | ISO-8601 string | — |
| `gene.log(msg)` | — | to the console log at debug; first 20 lines per run kept with `trigger-error`/`trigger-fired` rows |

**exec hardening.** Matching is on whole tokens, not substrings (`glab api` matches
`glab api foo`, not `glab apix`). For `glab api` specifically, args containing `-X`,
`--method`, `-f`, `-F`, `--field`, `--raw-field`, `--input` are rejected (read-only GET).
Commands that print secrets (`bao kv get`, …) are the operator's responsibility to keep off
the allowlist; the docs say so.

**Limits per run** (exceeding any = error outcome, never a fire):

- memory 16 MB (`runtime.setMemoryLimit`), max stack 512 KB
- 1 s **JS CPU** via `runtime.setInterruptHandler` (time spent awaiting host calls excluded)
- 60 s wall clock total
- ≤ 10 `fetch` + `exec` calls combined

**Result.** `check` must resolve to `{ fire: boolean, reason?: string }`; `reason` is
truncated to 500 chars. Anything else is an error. Only this object (plus `state` and log
lines) leaves the sandbox.

**Module layout** — `src/trigger/`:

- `sandbox.ts` — `runCheck(code, host, limits) → { fire, reason, state, logs, usedIo }`.
  Knows nothing about programs; host functions are injected (tests pass fakes).
- `host.ts` — the real `fetch` / `exec` / `cron` implementations + allowlist matching.
- `compile.ts` — prompt building, reply parsing, validation, retry; the `claude` runner is
  injected.
- `schedule.ts` — pure `decideTrigger(...)` gate function + cron-window helpers.
- `store.ts` — `program_trigger` reads/writes.
- `index.ts` — `scanTriggers(programs)` glue called from `scanPrograms`.

## 3. Scheduling and firing

**Check cadence.** The compiled `INTERVAL` is clamped to `[poll interval, 24 h]`. If the
previous run used `fetch`/`exec` (`usedIo`), the effective interval is at least
`GENE_TRIGGER_IO_MIN_INTERVAL_MIN` (default 5). Pure cron checks have no floor.
`next_check_at = now + effective interval` after every due evaluation (run or skipped).

**Gates**, evaluated in order when a trigger is due (`status = ok`, `now ≥ next_check_at`):

1. **Not resting** — program in `ACTIVE_STATE` or `BLOCKED_STATE`, run in flight, or a fire
   already pending → `skipped:busy`, check not run.
2. **Cooldown** — `program_state.last_fired_at` (any source, so a manual `g` counts) is
   within `GENE_PROGRAM_TRIGGER_COOLDOWN_MIN` (default 30) → `skipped:cooldown`, check not
   run.
3. **Run the check.** `fire: true` → `fireProgram(identifier, "trigger", reason)`; the
   existing scan dispatches it (records resting state, In Progress, restore).

**Cron window.** `window_start = last_check_at` (initialised to compile time, so a fresh
compile never fires on a past tick). Every due evaluation — including skipped ones — sets
`last_check_at = now`. So a tick that passes while busy or cooling down is **dropped**,
not queued; after daemon downtime at most **one** catch-up fire happens (one window covers
the gap). Condition checks simply re-evaluate next time.

**Fire queue change.** `pendingFires` becomes `Map<id, { source, reason? }>`;
`takeFireRequest` returns the object. The program prompt gains a "Why this run fired"
section when `reason` is set. Manual `g` behaviour is unchanged (bypasses trigger gates,
restarts a running program).

**Errors** (throw, limit, bad shape): log `trigger-error`; `error_streak += 1`; next check
backs off — effective interval × 2^streak, capped at 1 h. At `error_streak = 3`, post one
ticket comment `⚠️ Trigger check failing: <error>` + `#gene-ai` (`error_commented = true`).
First success resets both. Errors never fire.

**Dry run** (`GENE_DRY_RUN=true`): compiles and checks run; a fire logs
`would fire (<reason>)` and does not enqueue. Failure comments are not posted.

**Rollout.** `GENE_PROGRAM_TRIGGERS` defaults to **false**: existing programs' `## Trigger`
text was written as informational, so auto-firing must be an explicit opt-in. Off = no
compiles, no checks, no TUI trigger status.

## 4. Storage, TUI, logging

**Table** (added to `SCHEMA` in `src/db.ts`):

```sql
CREATE TABLE IF NOT EXISTS program_trigger (
  tracker         TEXT NOT NULL,
  identifier      TEXT NOT NULL,
  prose_hash      TEXT NOT NULL,
  status          TEXT NOT NULL,            -- ok | uncompilable | invalid
  summary         TEXT,
  code            TEXT,
  interval_sec    INTEGER,
  compile_error   TEXT,
  compiled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_check_at   TIMESTAMPTZ,
  next_check_at   TIMESTAMPTZ,
  last_outcome    TEXT,                     -- fire | no-fire | error | skipped:busy | skipped:cooldown
  last_reason     TEXT,
  used_io         BOOLEAN NOT NULL DEFAULT false,
  error_streak    INTEGER NOT NULL DEFAULT 0,
  error_commented BOOLEAN NOT NULL DEFAULT false,
  state           JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tracker, identifier)
);
```

**Activity log** (`issue_log`): `trigger-compiled`, `trigger-uncompilable`,
`trigger-fired` (reason), `trigger-error`. No-fire checks are not logged there (they only
update `last_*` + a debug console line).

**TUI.**

- List: programs keep **⟳**; a program with an `ok` compiled trigger shows **⚡** instead;
  `uncompilable` / `invalid` / `error_streak > 0` render the glyph in the warning colour.
- Detail, Trigger section: the prose, then a status line, e.g.
  `⚡ Weekdays 09:00 Europe/Berlin · every 1m · next 09:00 · last: no fire 08:59`,
  or the compile/check error.
- **`t`** in the detail view toggles the compiled code (unused key today).
- `g` unchanged.

**Config** (`src/config.ts`, all new, global):

| Env | Default |
|---|---|
| `GENE_PROGRAM_TRIGGERS` | `false` |
| `GENE_PROGRAM_TRIGGER_COOLDOWN_MIN` | `30` |
| `GENE_TRIGGER_EXEC_ALLOW` | empty (comma-separated prefixes) |
| `GENE_TRIGGER_IO_MIN_INTERVAL_MIN` | `5` |
| `GENE_TRIGGER_COMPILE_MODEL` | `haiku` |

Documented in README "Programs" (replacing "Triggers are a later phase") and
`.gene.config.example`.

## Testing

`node:test`, no network, no real `claude`:

- **sandbox** — API round-trips with fake host fns; each limit (CPU loop, memory, wall
  clock, call count, state size); non-function `check`; bad result shapes; globals absent.
- **host** — allowlist token matching; `glab api` write-flag rejection; fetch scheme
  rejection; output truncation (local `execFile` of `node -e`).
- **schedule** — `decideTrigger` gate order; cron window (skipped advances window, single
  catch-up, no fire right after compile); interval clamp, IO floor, error backoff.
- **compile** — reply parsing (code fence, SUMMARY, INTERVAL, UNCOMPILABLE), validation
  failure → one retry with error, stub runner.
- **store** — round-trip against PGlite in a temp `GENE_DB_DIR`.
- **integration** — the trigger scanner (`src/trigger/index.ts`) with injected deps (stub
  compile runner, real sandbox, in-memory store fakes): new prose → compiled → due cron →
  `fire(identifier, reason)` called once; busy/cooldown skip; failure comment once per hash.
  (`index.ts` can't be imported in tests, so the scanner takes its daemon hooks as deps.)

## Out of scope

Webhooks / inbound ingress; triggers on coding tickets; a manual recompile key (edit the
prose); running checks inside the Docker/msb agent sandbox; per-program exec allowlists.

## Accepted limitations

- Cron resolution is the poll interval (default 60 s): a 09:00 tick fires by ~09:01.
- A condition that stays true re-fires every cooldown period until the run fixes it —
  that is the intended safety limit. To silence it, set `## Trigger` to `manual` (or
  remove the Program label). `!gene stop` only abandons a Blocked run; it does not
  disarm the trigger.
- The compiler can misread prose; the summary in the TUI and the `trigger-compiled` log
  row are how a human catches that.
