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
