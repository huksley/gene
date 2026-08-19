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
