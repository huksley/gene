import { test } from "node:test";
import assert from "node:assert/strict";
import { describePgUrl, withSchemaRepair, type Db } from "./db.ts";

const undefinedTable = (): Error => Object.assign(new Error('relation "review_cursor" does not exist'), { code: "42P01" });

/** A fake store whose tables are missing until the schema is exec'd. */
const fakeDb = (): Db & { execs: number; queries: number } => {
  let present = false;
  const db = {
    execs: 0,
    queries: 0,
    query: async <T>(): Promise<{ rows: T[] }> => {
      db.queries++;
      if (!present) {
        throw undefinedTable();
      }
      return { rows: [] };
    },
    exec: async (): Promise<void> => {
      db.execs++;
      await new Promise(resolve => setImmediate(resolve));
      present = true;
    },
    end: async (): Promise<void> => { }
  };
  return db;
};

test("withSchemaRepair recreates missing tables and retries the query", async () => {
  const inner = fakeDb();
  const db = withSchemaRepair(inner, "CREATE TABLE t ()");
  assert.deepEqual(await db.query("SELECT 1"), { rows: [] });
  assert.equal(inner.execs, 1);
  assert.equal(inner.queries, 2);
});

test("withSchemaRepair shares one repair between concurrent misses", async () => {
  const inner = fakeDb();
  const db = withSchemaRepair(inner, "CREATE TABLE t ()");
  await Promise.all([db.query("SELECT 1"), db.query("SELECT 2"), db.query("SELECT 3")]);
  assert.equal(inner.execs, 1);
});

test("withSchemaRepair passes other errors through untouched", async () => {
  const inner = fakeDb();
  inner.query = async () => {
    throw Object.assign(new Error("syntax error"), { code: "42601" });
  };
  const db = withSchemaRepair(inner, "CREATE TABLE t ()");
  await assert.rejects(db.query("SELEC 1"), /syntax error/);
  assert.equal(inner.execs, 0);
});

test("describePgUrl drops credentials", () => {
  assert.equal(describePgUrl("postgres://me:secret@db.local:5434/gene"), "db.local:5434/gene");
  assert.equal(describePgUrl("postgres://me@127.0.0.1/postgres"), "127.0.0.1:5432/postgres");
  assert.equal(describePgUrl("not a url"), "via GENE_DATABASE_URL");
});
