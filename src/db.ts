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
`;

let dbPromise: Promise<PGlite> | null = null;

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
      throw error;
    });
  }
  return dbPromise;
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
