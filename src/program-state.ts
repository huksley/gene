/**
 * Per-program lifecycle state. This is OBSERVABILITY/status, NOT a lock — mutual
 * exclusion for a running program is the per-issue file lock (lock.ts `withLock`),
 * exactly as coding runs use it. The upsert COALESCE-merges: a "fire" write records
 * lastFiredAt/lastSource; a "finish" write records lastResult/lastFiredAt without
 * needing to re-supply (and thus clobber) lastSource.
 *
 * There is no resting state: a program at rest is always in the trigger state (Todo).
 * The `resting_state` column is legacy and no longer read or written.
 */
import { getDb } from "./db.ts";

export type ProgramState = {
  lastFiredAt?: string;
  lastResult?: string;
  lastSource?: string;
};

type Row = {
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
    "SELECT last_fired_at, last_result, last_source FROM program_state WHERE tracker = $1 AND identifier = $2",
    [tracker, identifier]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
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
    `INSERT INTO program_state (tracker, identifier, last_fired_at, last_result, last_source, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (tracker, identifier) DO UPDATE SET
       last_fired_at = COALESCE(EXCLUDED.last_fired_at, program_state.last_fired_at),
       last_result   = COALESCE(EXCLUDED.last_result,   program_state.last_result),
       last_source   = COALESCE(EXCLUDED.last_source,   program_state.last_source),
       updated_at    = now()`,
    [
      tracker,
      identifier,
      state.lastFiredAt ?? null,
      state.lastResult ?? null,
      state.lastSource ?? null
    ]
  );
};
