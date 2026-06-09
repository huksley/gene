/**
 * The daemon's persistent state, in a local Postgres.
 *
 * Most of Gene's "state" lives in Linear (the issue + its comments) and the forge
 * (the open change request). What's left is bookkeeping the daemon needs across
 * restarts but that has no natural home in either: the In-Review cursor (review.ts)
 * — which CI failure / review comment we've already dispatched an agent for, so the
 * watchdog acts once per signal instead of on every poll — and a per-issue activity
 * log.
 *
 * We talk to a real Postgres over TCP (run it with `npm run pg` — port 5433, data
 * under `data/pg`; see pg.conf). Connection details come from the standard PG* env
 * vars (or a single DATABASE_URL), defaulting to that local dev server. The pool is
 * opened lazily and memoised for the process; unlike the previous embedded engine,
 * the daemon and a one-shot command (`log` / `reset`) can hold it at the same time.
 *
 * NB: per-issue *locks* deliberately stay file-based (lock.ts) — they coordinate
 * across separate OS processes via PID + stale reclamation. This store is for
 * cross-restart bookkeeping only.
 */

import os from "node:os";
import { Pool } from "pg";
import logger from "./logger.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS review_cursor (
    issue_id            TEXT PRIMARY KEY,
    handled_failed_sha  TEXT,
    handled_comment_at  TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS issue_log (
    id          BIGSERIAL PRIMARY KEY,
    tracker     TEXT NOT NULL,
    identifier  TEXT NOT NULL,
    event       TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS issue_log_lookup ON issue_log (tracker, identifier, id);
`;

let dbPromise: Promise<Pool> | null = null;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Connection errors worth retrying: the daemon and `npm run pg` are started together
 * (concurrently), so on a cold boot the first query can race Postgres still coming up
 * (and `initdb` on the very first run). Anything else — bad credentials, a missing
 * database — is a real misconfiguration and fails fast.
 */
const isStartupError = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code;
  return (
    code === "ECONNREFUSED" || // nothing listening on the port yet
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "57P03" // cannot_connect_now — server is still starting up
  );
};

/** Open the pool, wait for the server to accept queries, then apply the schema. */
const open = async (): Promise<Pool> => {
  const url = process.env.DATABASE_URL;
  // Discrete config defaults to the local dev server in pg.conf (127.0.0.1:5433).
  // `initdb` makes the bootstrap superuser = the OS user and trust-auths localhost,
  // so no password is needed out of the box; PGPASSWORD/PGUSER override when it is.
  const discrete = {
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 5433),
    database: process.env.PGDATABASE ?? "postgres",
    user: process.env.PGUSER ?? os.userInfo().username,
    ...(process.env.PGPASSWORD ? { password: process.env.PGPASSWORD } : {})
  };
  const pool = new Pool(url ? { connectionString: url } : discrete);
  // A server-dropped idle client surfaces as a pool 'error'; log and swallow it so a
  // transient disconnect can't crash the daemon (the next query reconnects).
  pool.on("error", error =>
    logger.warn(`${logger.tag.db} idle client error:`, error instanceof Error ? error.message : error)
  );

  const deadline = Date.now() + 30_000;
  let delay = 250;
  for (; ;) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (error) {
      if (!isStartupError(error) || Date.now() > deadline) {
        await pool.end().catch(() => { });
        throw error;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }

  await pool.query(SCHEMA);
  const where = url ? "via DATABASE_URL" : `${discrete.host}:${discrete.port}/${discrete.database}`;
  logger.info(`${logger.tag.db} connected to Postgres (${where})`);
  return pool;
};

/** Lazily open (and migrate) the pool; the same instance is reused thereafter. */
export const getDb = async (): Promise<Pool> => {
  if (!dbPromise) {
    logger.info(`${logger.tag.db} opening pool to ${process.env.DATABASE_URL ?? "local dev server"}`);
    dbPromise = open().catch(error => {
      dbPromise = null; // allow a later retry rather than wedging on a transient failure
      throw error;
    });
  }
  return dbPromise;
};

// --- Per-issue activity log -------------------------------------------------
// A persistent, append-only record of what the daemon did for each issue, keyed
// by (tracker system, issue/card id). Surfaced by `npm run log -- <sys>:<id>`.

/** One action to append to an issue's activity log. */
export type IssueLogEntry = {
  /** Tracker system the issue lives in — "linear" / "trello" (tracker.name). */
  tracker: string;
  /** Issue/card id (CLOUD-1094 / a Trello shortLink). */
  identifier: string;
  /** Short event kind: "dispatch" / "agent-start" / "agent-done" / "review" / "reset" / … */
  event: string;
  /** Human-readable description of what happened. */
  detail?: string;
};

/** One row read back from the activity log. */
export type IssueLogRow = { createdAt: string; event: string; detail: string; tracker: string; identifier: string };

/**
 * Append one entry to an issue's activity log. Best-effort: recording is
 * bookkeeping, so a logging failure is warned and swallowed rather than allowed
 * to break the pipeline action it was describing.
 */
export const logEvent = async (entry: IssueLogEntry): Promise<void> => {
  try {
    const db = await getDb();
    await db.query("INSERT INTO issue_log (tracker, identifier, event, detail) VALUES ($1, $2, $3, $4)", [
      entry.tracker,
      entry.identifier,
      entry.event,
      entry.detail ?? ""
    ]);
  } catch (error) {
    logger.warn(
      `${logger.tag.db} could not record activity log entry:`,
      error instanceof Error ? error.message : error
    );
  }
};

/** Read an issue's activity log, oldest-first. Identifier match is case-insensitive. */
export const readIssueLog = async (tracker?: string, identifier?: string): Promise<IssueLogRow[]> => {
  const db = await getDb();
  const res = await db.query<{ created_at: Date | string; event: string; detail: string; tracker: string; identifier: string }>(
    `SELECT created_at, event, detail, tracker, identifier
        FROM issue_log
      WHERE ($1::text IS NULL OR tracker = $1) AND ($2::text IS NULL OR lower(identifier) = lower($2))
      ORDER BY id ASC`,
    [tracker ?? null, identifier ?? null]
  );
  return res.rows.map(row => ({
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    event: row.event,
    detail: row.detail,
    tracker: row.tracker,
    identifier: row.identifier
  }));
};

/**
 * Close the pool if it was ever opened, so a one-shot `--once` / `log` / `reset` run
 * can exit instead of lingering on open sockets. Idempotent and never throws — a
 * close failure shouldn't wedge shutdown.
 */
export const closeDb = async (): Promise<void> => {
  if (!dbPromise) {
    return;
  }
  const pending = dbPromise;
  dbPromise = null;
  try {
    const db = await pending;
    await db.end();
  } catch {
    // Failed to open, or already closed — nothing left to release.
  }
};
