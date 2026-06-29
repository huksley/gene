/**
 * The daemon's persistent state — a small bit of bookkeeping with no natural home
 * in Linear or the forge: the In-Review cursor (review.ts) — which CI failure /
 * review comment we've already dispatched an agent for, so the watchdog acts once
 * per signal instead of on every poll — and a per-issue activity log.
 *
 * The store is **hybrid**, chosen at open time so Gene is self-contained out of the
 * box yet scales up when asked:
 *
 *   - **Embedded PGlite (default).** With no Postgres env set, we run Postgres-in-WASM
 *     in-process and keep its data under `~/.config/gene/pgdata` (XDG-aware; override
 *     with GENE_DB_DIR). Zero setup — no server to install or start. PGlite is real
 *     Postgres, so every query below (jsonb, DISTINCT ON, BIGSERIAL, ON CONFLICT)
 *     runs unchanged. It is *single-process*, though: only one process can hold the
 *     data dir, so a one-shot `log`/`reset` can't run while the daemon is up.
 *   - **Postgres server (opt-in).** If DATABASE_URL or any standard libpq var
 *     (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGHOSTADDR/PGSERVICE) is set, we
 *     connect to that server over TCP via `pg`. This is what allows the daemon and a
 *     concurrent one-shot to hold the store at the same time. `npm run pg` brings up
 *     a throwaway local server on 5434 for exactly this.
 *
 * The handle is opened lazily and memoised for the process. Both engines are exposed
 * through one minimal `Db` interface (`query` + `end`) so the rest of the daemon is
 * engine-agnostic.
 *
 * NB: per-issue *locks* deliberately stay file-based (lock.ts) — they coordinate
 * across separate OS processes via PID + stale reclamation. This store is for
 * cross-restart bookkeeping only.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import type { PGliteOptions } from "@electric-sql/pglite";
import logger from "./logger.ts";
import { inSea, wasmAsset, blobAsset } from "./sea-assets.ts";

/**
 * The engine-agnostic surface the rest of the daemon uses — the common subset of
 * `pg`'s Pool and PGlite. Both speak `$1`-style params and return `{ rows }`, so
 * consumers (review.ts + the helpers below) need nothing more.
 */
export type Db = {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  /** Run a multi-statement SQL script with no params (schema setup, legacy import). */
  exec: (sql: string) => Promise<void>;
  end: () => Promise<void>;
};

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

  -- Structured, JSON-serialisable companion to issue_log.detail: the agent's
  -- response stream (assistant text, tool-use summaries, errors, final result),
  -- attached to agent-done / agent-error rows. Added via ALTER so databases
  -- created before this column gain it on the next open.
  ALTER TABLE issue_log ADD COLUMN IF NOT EXISTS data JSONB;

  -- Per-run token usage, attached to a run's terminal row (agent-done / -error /
  -- -stalled / -cancelled). Summed at startup into the monitor's lifetime base so
  -- the dashboard's running total survives daemon restarts. NULL on non-run rows.
  ALTER TABLE issue_log ADD COLUMN IF NOT EXISTS tokens_in  BIGINT;
  ALTER TABLE issue_log ADD COLUMN IF NOT EXISTS tokens_out BIGINT;
`;

let dbPromise: Promise<Db> | null = null;

/**
 * Aborts an in-flight {@link openPg} connect-retry loop the moment shutdown begins, so
 * Ctrl+C while the Postgres server is still coming up exits at once instead of blocking
 * on the remaining 30s retry budget. Created per open attempt in {@link getDb}.
 */
let openAbort: AbortController | null = null;

/**
 * Latched by {@link closeDb}: once shutdown has begun, refuse to start a *new* open (a
 * fresh retry loop). Otherwise a second consumer running right after the first (e.g.
 * seedTokenTotals after reconcile) would restart the loop the instant we cancelled it.
 */
let closing = false;

/**
 * Promise delay that resolves early when `signal` aborts — lets a shutdown cut short the
 * connect-retry backoff in {@link openPg} instead of waiting out the full interval.
 */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Standard libpq *client* connection vars. If any is set, the operator has pointed
 * Gene at a Postgres server, so we use `pg`; with none set we fall back to embedded
 * PGlite. PGDATA and other server-side knobs are deliberately excluded — they
 * configure a server, not a connection.
 */
const PG_ENV_VARS = ["DATABASE_URL", "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSERVICE"];

/** True when Gene is configured to talk to a Postgres server (rather than embedded PGlite). */
export const pgConfigured = (): boolean => PG_ENV_VARS.some(key => (process.env[key] ?? "").trim() !== "");

/** Embedded PGlite's data dir: $GENE_DB_DIR, else $XDG_CONFIG_HOME/gene/pgdata, else ~/.config/gene/pgdata. */
export const pgliteDir = (): string => {
  const override = (process.env.GENE_DB_DIR ?? "").trim();
  if (override) {
    return override;
  }
  const base = (process.env.XDG_CONFIG_HOME ?? "").trim() || path.join(os.homedir(), ".config");
  return path.join(base, "gene", "pgdata");
};

/**
 * Connection errors worth retrying: a server can still be coming up when the first
 * query lands (e.g. `npm run pg` started alongside the daemon, or `initdb` on a cold
 * boot). Anything else — bad credentials, a missing database — is a real
 * misconfiguration and fails fast. (PGlite is in-process, so this never applies to it.)
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

/** Connect to a Postgres server, wait for it to accept queries, then apply the schema. */
const openPg = async (signal?: AbortSignal): Promise<Db> => {
  const url = process.env.DATABASE_URL;
  // Discrete config defaults to the local dev server in pg.conf (127.0.0.1:5434).
  // `initdb` makes the bootstrap superuser = the OS user and trust-auths localhost,
  // so no password is needed out of the box; PGPASSWORD/PGUSER override when it is.
  const discrete = {
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 5434),
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
    // Ctrl+C aborts the signal mid-startup: stop retrying now and unwind toward exit,
    // rather than holding the process open for the rest of the 30s budget waiting for a
    // server that's still coming up (or never will). closeDb() triggers the abort.
    if (signal?.aborted) {
      await pool.end().catch(() => { });
      throw new Error("Postgres connection attempt cancelled — shutting down");
    }
    try {
      await pool.query("SELECT 1");
      break;
    } catch (error) {
      if (!isStartupError(error) || Date.now() > deadline) {
        await pool.end().catch(() => { });
        throw error;
      }
      await sleep(delay, signal);
      delay = Math.min(delay * 2, 2_000);
    }
  }

  await pool.query(SCHEMA);
  const where = url ? "via DATABASE_URL" : `${discrete.host}:${discrete.port}/${discrete.database}`;
  logger.info(`${logger.tag.db} connected to Postgres (${where})`);
  return {
    // pg's extended protocol (with values) is single-statement; the multi-statement
    // SCHEMA above goes through the simple protocol (no values), so route accordingly.
    query: async <T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> => {
      const res = await (params ? pool.query(sql, params) : pool.query(sql));
      return { rows: res.rows as T[] };
    },
    // Simple protocol (no values) runs the whole multi-statement script in one round trip.
    exec: async (sql: string): Promise<void> => {
      await pool.query(sql);
    },
    end: () => pool.end()
  };
};

// --- Embedded-store single-process lock ------------------------------------
// PGlite holds the data dir in-process and does NOT coordinate across OS processes:
// two openers corrupt the directory (verified). So in embedded mode we guard the dir
// with a PID lock (a sibling `<dir>.lock`), mirroring lock.ts — a live owner means
// "in use, refuse"; a dead owner's lock is reclaimed. Unlike the per-issue lock there
// is deliberately NO age expiry: the daemon legitimately holds the store for its
// entire lifetime. A Postgres server (pg mode) needs none of this — it arbitrates
// concurrent connections itself.

type DbLock = { pid: number; acquiredAt: number };

const storeLockPath = (dir: string): string => `${dir}.lock`;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Take the embedded-store lock for `dir`; throw a clear error if another live process holds it. */
const acquireStoreLock = (dir: string): string => {
  const file = storeLockPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), { flag: "wx" });
      return file;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") {
        throw error;
      }
      let owner: DbLock | null = null;
      try {
        owner = JSON.parse(fs.readFileSync(file, "utf-8")) as DbLock;
      } catch {
        owner = null;
      }
      if (owner && typeof owner.pid === "number" && owner.pid !== process.pid && pidAlive(owner.pid)) {
        throw new Error(
          `embedded state store at ${dir} is already in use by PID ${owner.pid} (the Gene daemon?). ` +
          "Stop that process to run this command, or set DATABASE_URL / PG* to use a shared Postgres " +
          "server for concurrent access (`npm run pg` brings up a local one)."
        );
      }
      // Stale (dead owner, unreadable, or our own leftover) — reclaim and retry once.
      logger.warn(`${logger.tag.db} reclaiming stale store lock (pid ${owner?.pid ?? "?"})`);
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    }
  }
  throw new Error(`could not acquire embedded state store lock at ${storeLockPath(dir)}`);
};

/** Release the embedded-store lock, but only if we still own it. */
const releaseStoreLock = (file: string): void => {
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf-8")) as DbLock;
    if (owner?.pid === process.pid) {
      fs.unlinkSync(file);
    }
  } catch {
    /* already gone, or not ours */
  }
};

/**
 * Run `fn` with any global `window` temporarily removed, restoring it afterwards.
 *
 * PGlite's Emscripten runtime auto-detects a browser environment via `typeof window
 * === "object"` and then dereferences `window.location.pathname` while loading its
 * data package (during initdb on a cold data dir). That is fine under plain Node —
 * there is no `window` — but the OpenTUI dashboard's renderer installs a bare
 * `global.window = {}` (a requestAnimationFrame shim with no `location`), so with the
 * UI up the detection misfires and the open throws "Cannot read properties of
 * undefined (reading 'pathname')". Headless mode has no `window` and opens cleanly; we
 * recreate that condition for the brief construct-and-initialise window only — the sole
 * point Emscripten probes the environment — then put OpenTUI's `window` straight back so
 * its RAF shim keeps working. Subsequent queries never re-probe, so they're unaffected.
 */
const withWindowHidden = async <T>(fn: () => Promise<T>): Promise<T> => {
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  const saved = g.window;
  if (had) {
    delete g.window;
  }
  try {
    return await fn();
  } finally {
    if (had) {
      g.window = saved;
    }
  }
};

/** Open embedded PGlite (Postgres-in-WASM) at its data dir, under a single-process lock, and apply the schema. */
const openPglite = async (): Promise<Db> => {
  const dir = pgliteDir();
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = acquireStoreLock(dir);
  try {
    // Lazy import so the WASM engine is only loaded when actually used (not in pg mode).
    const { PGlite } = await import("@electric-sql/pglite");
    // In dev, PGlite's default loader finds its WASM next to the package via
    // import.meta.url. Inside the single executable that path points at the binary,
    // so we hand it the payloads we embedded as SEA assets instead.
    const options: PGliteOptions = { dataDir: dir };
    if (inSea()) {
      options.pgliteWasmModule = wasmAsset("pglite.wasm");
      options.initdbWasmModule = wasmAsset("initdb.wasm");
      options.fsBundle = blobAsset("pglite.data");
    }
    // Construct and initialise (initdb on a cold dir) with any global `window` hidden,
    // so PGlite's Emscripten runtime detects Node rather than a browser — see
    // withWindowHidden. exec() of the multi-statement SCHEMA is what awaits that init, so
    // it has to run inside the shield too; query() is single-statement only.
    const lite = await withWindowHidden(async () => {
      const instance = new PGlite(options);
      await instance.exec(SCHEMA);
      return instance;
    });
    logger.info(`${logger.tag.db} embedded PGlite at ${dir} (single-process — set DATABASE_URL/PG* for a shared server)`);
    return {
      query: async <T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> => {
        const res = await lite.query(sql, params);
        return { rows: res.rows as T[] };
      },
      exec: async (sql: string): Promise<void> => {
        await lite.exec(sql);
      },
      end: async () => {
        try {
          await lite.close();
        } finally {
          releaseStoreLock(lockFile);
        }
      }
    };
  } catch (error) {
    releaseStoreLock(lockFile); // don't leave the lock held on a failed open
    throw error;
  }
};

/** Open the configured engine (PGlite by default, Postgres when env points at one). */
const open = (signal?: AbortSignal): Promise<Db> => (pgConfigured() ? openPg(signal) : openPglite());

/**
 * Repair the BIGSERIAL sequence behind issue_log.id when it has fallen behind the rows
 * actually present. A legacy import (import-legacy.ts) replays a dump that inserts rows
 * with their original explicit ids, which does NOT advance the sequence; left unrepaired
 * the next live insert reuses an existing id and dies with a duplicate-key error on
 * issue_log_pkey. Called on every open so a store imported by an older build self-heals
 * on the next launch — no need to re-run --import-legacy.
 *
 * It's a single atomic statement that only advances the sequence when nextval() would
 * actually collide (next value <= MAX(id)), so in normal operation it's a no-op and never
 * moves the sequence backward — safe to run on a shared Postgres while the daemon writes.
 * Best-effort: a repair failure must never block opening the store.
 */
export const resyncIssueLogSeq = async (db: Db): Promise<void> => {
  try {
    const { rows } = await db.query<{ seq: string | null }>(
      "SELECT pg_get_serial_sequence('issue_log', 'id') AS seq",
    );
    const seq = rows[0]?.seq;
    if (!seq) return; // column isn't serial-backed (shouldn't happen) — nothing to repair
    // The aggregate subquery yields exactly one row; WHERE prunes it unless the sequence
    // is behind, so setval() is evaluated only when a repair is actually needed. A non-empty
    // result means it fired. setval(seq, MAX(id), true) makes the next nextval() return MAX+1.
    const res = await db.query<{ setval: string }>(
      `SELECT setval('${seq}'::regclass, m.mx, true)
         FROM (SELECT MAX(id) AS mx FROM issue_log) m
        WHERE m.mx IS NOT NULL
          AND m.mx >= (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM ${seq})`,
    );
    if (res.rows.length > 0) {
      logger.warn(
        `${logger.tag.db} issue_log id sequence was behind existing rows; resynced (next id ${BigInt(res.rows[0].setval) + 1n})`,
      );
    }
  } catch (error) {
    logger.warn(`${logger.tag.db} issue_log sequence resync skipped: ${(error as Error).message}`);
  }
};

/** Lazily open (and migrate) the store; the same instance is reused thereafter. */
export const getDb = async (): Promise<Db> => {
  if (!dbPromise) {
    if (closing) {
      // Shutdown already began (closeDb ran) — don't start a fresh connect-retry loop,
      // which is exactly what we just cancelled. Fail fast so the caller unwinds to exit.
      throw new Error("state store is shutting down");
    }
    logger.info(`${logger.tag.db} opening state store (${pgConfigured() ? "Postgres" : "embedded PGlite"})`);
    openAbort = new AbortController();
    dbPromise = open(openAbort.signal)
      // Self-heal a sequence left behind by a prior legacy import, so an already-imported
      // store recovers on the next launch without having to re-run --import-legacy.
      .then(async db => {
        await resyncIssueLogSeq(db);
        return db;
      })
      .catch(error => {
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
  /**
   * Optional structured payload stored in the `data` JSONB column — used to keep
   * the agent's full response stream alongside the human-readable `detail`.
   */
  data?: unknown;
  /** This run's total input tokens (folded cache included) — set on terminal run rows. */
  tokensIn?: number;
  /** This run's total output tokens — set on terminal run rows. */
  tokensOut?: number;
};

/** One row read back from the activity log. */
export type IssueLogRow = { createdAt: string; event: string; detail: string; tracker: string; identifier: string; data?: unknown };

/**
 * Append one entry to an issue's activity log. Best-effort: recording is
 * bookkeeping, so a logging failure is warned and swallowed rather than allowed
 * to break the pipeline action it was describing.
 */
export const logEvent = async (entry: IssueLogEntry): Promise<void> => {
  try {
    const db = await getDb();
    await db.query(
      "INSERT INTO issue_log (tracker, identifier, event, detail, data, tokens_in, tokens_out) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)",
      [
        entry.tracker,
        entry.identifier,
        entry.event,
        entry.detail ?? "",
        // pg renders a JS array as a Postgres array literal, not JSON, so
        // stringify ourselves and let the ::jsonb cast parse it; undefined → NULL.
        entry.data === undefined ? null : JSON.stringify(entry.data),
        entry.tokensIn ?? null,
        entry.tokensOut ?? null
      ]
    );
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
  const res = await db.query<{ created_at: Date | string; event: string; detail: string; tracker: string; identifier: string; data: unknown }>(
    `SELECT created_at, event, detail, tracker, identifier, data
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
    identifier: row.identifier,
    data: row.data ?? undefined
  }));
};

/**
 * Lifetime token total: sum of every run's persisted usage, optionally scoped to one
 * tracker. Read once at startup to seed the monitor's running total so the dashboard's
 * `Tokens:` line continues across restarts instead of resetting to zero. `sum()` over
 * BIGINT comes back as a string from pg, so coerce to number (well within 2^53 for
 * realistic counts).
 */
export const readTokenTotal = async (tracker?: string): Promise<{ in: number; out: number }> => {
  const db = await getDb();
  const res = await db.query<{ in: string | number; out: string | number }>(
    `SELECT coalesce(sum(tokens_in), 0) AS in, coalesce(sum(tokens_out), 0) AS out
       FROM issue_log
      WHERE ($1::text IS NULL OR tracker = $1)`,
    [tracker ?? null]
  );
  const row = res.rows[0];
  return { in: Number(row?.in ?? 0), out: Number(row?.out ?? 0) };
};

/**
 * Find runs that were in flight when their daemon died: the latest event for the
 * ticket is `agent-start` (the run began) with no outcome row after it. Used once
 * at daemon startup to reconcile orphaned runs — otherwise they linger in the
 * dashboard's history seed forever, reconstructed as a stale `queued`/`interrupted`
 * row. Returns the tracker + identifier of each; the caller records the closing
 * `agent-interrupted` event.
 */
export const findInterruptedRuns = async (): Promise<{ tracker: string; identifier: string }[]> => {
  const db = await getDb();
  const res = await db.query<{ tracker: string; identifier: string }>(
    `SELECT tracker, identifier
       FROM (
         SELECT DISTINCT ON (tracker, identifier) tracker, identifier, event
           FROM issue_log
          ORDER BY tracker, identifier, id DESC
       ) latest
      WHERE event = 'agent-start'`
  );
  return res.rows.map(row => ({ tracker: row.tracker, identifier: row.identifier }));
};

/**
 * Begin shutdown of the store: cancel any in-flight connect-retry loop, then close the
 * pool if it was ever opened — so a one-shot (`--once` / `log` / `reset`) or a Ctrl+C
 * during startup exits promptly instead of lingering on open sockets or a 30s retry.
 * Idempotent and never throws — a close failure shouldn't wedge shutdown.
 */
export const closeDb = async (): Promise<void> => {
  // Latch shutdown and abort any in-flight connect-retry loop (openPg) so a Ctrl+C while
  // Postgres is still coming up returns now, instead of awaiting a still-looping open
  // below. Harmless once the open has already settled (the abort then has no listener).
  closing = true;
  openAbort?.abort();
  if (!dbPromise) {
    return;
  }
  const pending = dbPromise;
  dbPromise = null;
  try {
    const db = await pending;
    await db.end();
  } catch {
    // Failed to open (incl. a cancelled connect), or already closed — nothing to release.
  }
};
