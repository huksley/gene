/**
 * `gene export [FILE]` — stream the entire state store to a JSON file.
 *
 * Dumps every table in the store — the per-issue activity log and the review
 * cursor today, plus any table added later: the set is discovered at runtime, not
 * hard-coded — so the bookkeeping that has no home in Linear/the forge can be
 * backed up, inspected, or carried between an embedded PGlite store and a shared
 * Postgres.
 *
 * Streaming, not buffered: rows are paged out of each table in batches (keyset
 * pagination on its primary key) and written straight to the file through a
 * WriteStream, awaiting each chunk's flush for backpressure. Peak memory stays at
 * one batch even when `issue_log.data` holds large agent-response payloads and the
 * table has grown to hundreds of MB — nothing assembles the whole document in
 * memory.
 *
 * The dump is a point-in-time snapshot taken WITHOUT an explicit transaction (the
 * pooled Postgres handle can't pin one connection across paged reads). In the
 * default embedded mode the daemon holds the single-process store lock, so
 * `gene export` only runs when nothing else is writing and the snapshot is
 * naturally consistent; against a shared Postgres with a live daemon it is a
 * best-effort snapshot.
 *
 * Output shape:
 *   {
 *     "meta": { tool, version, exportedAt, engine, location, tables: [...] },
 *     "data": { "<table>": [ {row}, ... ], ... }
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import logger from "./logger.ts";
import { getDb, pgConfigured, pgliteDir, type Db } from "./db.ts";
import { readVersion } from "./sea-assets.ts";

/** Rows fetched per page. Bounds peak memory regardless of table size. */
const BATCH = 500;

/** Default output file when the caller doesn't name one. */
const DEFAULT_FILE = "gene-export.json";

/** Double-quote a SQL identifier (table/column) so an odd name can't break the query. */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * JSON replacer that renders a BigInt as a string. PGlite hands BIGINT columns
 * back as JS `BigInt` (which `JSON.stringify` refuses to serialize), whereas `pg`
 * already returns them as strings — emitting strings in both keeps the output
 * identical across engines and never loses precision (ids/token counts can exceed
 * 2^53). All other values serialize normally (Date → ISO string, jsonb → object).
 */
const jsonSafe = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

/** Append a chunk and resolve once it has flushed (so we never outrun the buffer). */
const writeChunk = (stream: fs.WriteStream, chunk: string): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.write(chunk, error => (error ? reject(error) : resolve()));
  });

/** All base tables in the public schema, alphabetical. */
const listTables = async (db: Db): Promise<string[]> => {
  const res = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );
  return res.rows.map(r => r.table_name);
};

/** A table's primary-key columns, in key order ([] when it has no primary key). */
const primaryKey = async (db: Db, table: string): Promise<string[]> => {
  const res = await db.query<{ column_name: string }>(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public' AND tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
    [table]
  );
  return res.rows.map(r => r.column_name);
};

/**
 * Stream one table's rows into `stream` as a JSON array, returning the row count.
 * With a single-column primary key we page by keyset (`WHERE pk > $last`), so peak
 * memory is one batch. Composite-PK / PK-less tables (none today) fall back to a
 * single ordered read — still written incrementally, just fetched at once.
 */
const streamTable = async (db: Db, stream: fs.WriteStream, table: string): Promise<number> => {
  const pk = await primaryKey(db, table);
  const from = quoteIdent(table);
  let count = 0;

  const writeRows = async (rows: Record<string, unknown>[]): Promise<void> => {
    for (const row of rows) {
      await writeChunk(stream, `${count === 0 ? "\n      " : ",\n      "}${JSON.stringify(row, jsonSafe)}`);
      count++;
    }
  };

  await writeChunk(stream, "[");
  if (pk.length === 1) {
    const col = quoteIdent(pk[0]);
    let last: unknown;
    for (;;) {
      const { rows } = await db.query<Record<string, unknown>>(
        last === undefined
          ? `SELECT * FROM ${from} ORDER BY ${col} ASC LIMIT ${BATCH}`
          : `SELECT * FROM ${from} WHERE ${col} > $1 ORDER BY ${col} ASC LIMIT ${BATCH}`,
        last === undefined ? undefined : [last]
      );
      if (rows.length === 0) {
        break;
      }
      await writeRows(rows);
      last = rows[rows.length - 1][pk[0]];
      if (rows.length < BATCH) {
        break; // short page → that was the last one; skip the empty round-trip.
      }
    }
  } else {
    logger.warn(
      `${logger.tag.export} table "${table}" has ${pk.length ? "a composite" : "no"} primary key — ` +
        "exporting in a single read (not batched)"
    );
    const order = pk.length ? ` ORDER BY ${pk.map(quoteIdent).join(", ")}` : "";
    const { rows } = await db.query<Record<string, unknown>>(`SELECT * FROM ${from}${order}`);
    await writeRows(rows);
  }
  await writeChunk(stream, count === 0 ? "]" : "\n    ]");
  return count;
};

/**
 * Export the whole store to `file` (default {@link DEFAULT_FILE}) as streamed JSON.
 * On any failure the partial file is removed so a half-written dump can't be mistaken
 * for a good one. The caller owns the DB lifecycle (closeDb) and exit code.
 */
export const runExport = async (file: string = DEFAULT_FILE): Promise<void> => {
  const dest = path.resolve(file);
  const engine = pgConfigured() ? "postgres" : "pglite";
  // Never echo DATABASE_URL — it may embed a password; report only non-secret coordinates.
  const location = pgConfigured()
    ? process.env.DATABASE_URL
      ? "via DATABASE_URL"
      : `${process.env.PGHOST ?? "127.0.0.1"}:${process.env.PGPORT ?? 5434}/${process.env.PGDATABASE ?? "postgres"}`
    : pgliteDir();

  logger.info(`${logger.tag.export} exporting ${engine} store → ${dest}`);
  const db = await getDb();
  const tables = await listTables(db);

  const stream = fs.createWriteStream(dest, { encoding: "utf-8" });

  try {
    const meta = {
      tool: "gene",
      version: readVersion(),
      exportedAt: new Date().toISOString(),
      engine,
      location,
      tables
    };
    await writeChunk(stream, `{\n  "meta": ${JSON.stringify(meta)},\n  "data": {`);

    const counts: Record<string, number> = {};
    for (let i = 0; i < tables.length; i++) {
      await writeChunk(stream, `${i === 0 ? "\n    " : ",\n    "}${JSON.stringify(tables[i])}: `);
      counts[tables[i]] = await streamTable(db, stream, tables[i]);
    }
    await writeChunk(stream, `${tables.length ? "\n  }" : "}"}\n}\n`);

    stream.end();
    await finished(stream); // resolves on flush+close, rejects on any stream error

    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const summary = tables.length ? tables.map(t => `${t}=${counts[t]}`).join(", ") : "(no tables)";
    logger.info(`${logger.tag.export} wrote ${total} row(s) across ${tables.length} table(s): ${summary}`);
    logger.info(`${logger.tag.export} done → ${dest}`);
  } catch (error) {
    stream.destroy();
    try {
      fs.unlinkSync(dest); // drop the partial dump so it can't be mistaken for complete
    } catch {
      /* nothing written yet, or already gone */
    }
    throw error;
  }
};
