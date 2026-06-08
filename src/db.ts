/**
 * The daemon's persistent state, in an embedded Postgres (PGlite).
 *
 * Most of Gene's "state" lives in Linear (the issue + its comments) and the forge
 * (the open change request). What's left is bookkeeping the daemon needs across
 * restarts but that has no natural home in either — today that's the In-Review
 * cursor (review.ts): which CI failure / review comment we've already dispatched
 * an agent for, so the watchdog acts once per signal instead of on every poll.
 *
 * PGlite is a single-process WASM Postgres; we persist it under `.gene/pgdata`
 * (gitignored). The connection is lazily created and memoised for the process.
 *
 * NB: per-issue *locks* deliberately stay file-based (lock.ts) — they coordinate
 * across separate OS processes via PID + stale reclamation, which an in-process
 * database can't do. This store is for single-daemon bookkeeping only.
 */

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import logger from "./logger.ts";
import { GENE_DIR, PGDATA_DIR } from "./config.ts";

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

let dbPromise: Promise<PGlite> | null = null;

/**
 * Does the data dir hold a PG lock file? PGlite is single-process: a second opener
 * (e.g. `npm run log` while the daemon runs) aborts in WASM with an opaque
 * "Aborted()". PGlite writes postmaster.pid under the WASM getpid() — a fixed
 * sentinel (-42), so it can't be mapped back to a host PID; the file's mere
 * presence is what tells a locked store apart from real corruption.
 */
const storeIsLocked = (): boolean => existsSync(path.join(PGDATA_DIR, "postmaster.pid"));

/** Turn an opaque open failure into an actionable message when the store is locked. */
const augmentOpenError = (error: unknown): Error => {
  const original = error instanceof Error ? error.message : String(error);
  if (storeIsLocked()) {
    return new Error(
      `could not open the state store at ${PGDATA_DIR} — it is locked by another PGlite instance. ` +
        "PGlite is single-process, so only one of the daemon and a one-shot command (log / reset / once) " +
        "can hold it at a time. Stop the running Gene daemon, then retry. " +
        `(If no daemon is running, the lock is stale — remove ${path.join(PGDATA_DIR, "postmaster.pid")}.) ` +
        `[original: ${original}]`
    );
  }
  return error instanceof Error ? error : new Error(original);
};

/** Lazily open (and migrate) the database; the same instance is reused thereafter. */
export const getDb = async (): Promise<PGlite> => {
  if (!dbPromise) {
    dbPromise = (async () => {
      await mkdir(GENE_DIR, { recursive: true });
      const db = new PGlite(PGDATA_DIR);
      await db.waitReady;
      await db.exec(SCHEMA);
      logger.info(`[gene:db] state store ready at ${PGDATA_DIR}`);
      return db;
    })().catch(error => {
      dbPromise = null; // allow a later retry rather than wedging on a transient failure
      throw augmentOpenError(error);
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
export type IssueLogRow = { createdAt: string; event: string; detail: string };

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
      "[gene:db] could not record activity log entry:",
      error instanceof Error ? error.message : error
    );
  }
};

/** Read an issue's activity log, oldest-first. Identifier match is case-insensitive. */
export const readIssueLog = async (tracker: string, identifier: string): Promise<IssueLogRow[]> => {
  const db = await getDb();
  const res = await db.query<{ created_at: Date | string; event: string; detail: string }>(
    `SELECT created_at, event, detail
       FROM issue_log
      WHERE tracker = $1 AND lower(identifier) = lower($2)
      ORDER BY id ASC`,
    [tracker, identifier]
  );
  return res.rows.map(row => ({
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    event: row.event,
    detail: row.detail
  }));
};

/**
 * Close the database if it was ever opened. PGlite's WASM runtime keeps handles
 * on the event loop, so a one-shot `--once` run won't exit until this is called.
 * Idempotent and never throws — a close failure shouldn't wedge shutdown.
 */
export const closeDb = async (): Promise<void> => {
  if (!dbPromise) {
    return;
  }
  const pending = dbPromise;
  dbPromise = null;
  try {
    const db = await pending;
    await db.close();
  } catch {
    // Failed to open, or already closed — nothing left to release.
  }
};
