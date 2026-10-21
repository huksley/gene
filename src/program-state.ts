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

/**
 * Point an existing program's resting state at `state` — used by a reset, which has just
 * moved the ticket to the trigger state and so has made that its resting state. A plain
 * UPDATE, not the upsert above: a reset runs against coding issues too, and those must
 * not gain a program_state row. Returns quietly when the ticket has none.
 */
export const setRestingState = async (
  tracker: string,
  identifier: string,
  state: string
): Promise<void> => {
  const db = await getDb();
  await db.query(
    "UPDATE program_state SET resting_state = $3, updated_at = now() WHERE tracker = $1 AND identifier = $2",
    [tracker, identifier, state]
  );
};

/**
 * The state to restore a finished run to — never Done, never the *active* or *blocked*
 * state, nor undefined.
 *
 * The active-state guard is load-bearing, not belt-and-braces: a program whose recorded
 * resting state is the active state gets "restored" by {@link finishProgramRun} to the
 * one state that makes the next scan treat it as a run to resume, and it then re-fires
 * every poll forever (CLOUD-2014 ran 394 times that way). `activeState` is optional so
 * callers that genuinely have no notion of one keep the old two-guard behaviour.
 *
 * The blocked guard: Blocked means "waiting on a human", never "at rest". A program fired
 * from Blocked (the human unlocking it) recorded Blocked as its resting state, so every
 * finished run parked it there again — and a Blocked program's trigger never runs
 * (CLOUD-2243 and CLOUD-2629 sat silent for 13 days). It comes back to the trigger state
 * (Todo, "program activated") instead. An agent that parks a run in Blocked on purpose is
 * honoured before this is consulted (finishProgramRun).
 */
export const safeRestingState = (
  resting: string | undefined,
  doneState: string | undefined,
  triggerState: string,
  activeState?: string,
  blockedState?: string
): string => {
  if (!resting) return triggerState;
  if (doneState && resting === doneState) return triggerState;
  if (activeState && resting === activeState) return triggerState;
  if (blockedState && resting === blockedState) return triggerState;
  return resting;
};
