import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the embedded store at a throwaway dir BEFORE db.ts is imported.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gene-trigger-store-"));
process.env.GENE_DB_DIR = path.join(dir, "pgdata");
delete process.env.GENE_DATABASE_URL;

const { dbTriggerStore } = await import("./store.ts");
const { closeDb } = await import("../db.ts");

after(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("saveCompiled then read round-trips and resets runtime fields", async () => {
  const now = new Date("2026-10-07T09:00:00Z");
  await dbTriggerStore.saveCompiled(
    { tracker: "linear", identifier: "PRG-1", proseHash: "h1", status: "ok", summary: "hourly", code: "async function check(){return {fire:false}}", intervalSec: 60 },
    now
  );
  await dbTriggerStore.recordCheck("linear", "PRG-1", {
    lastCheckAt: now, nextCheckAt: new Date(now.getTime() + 60_000), lastOutcome: "error",
    errorStreak: 2, errorCommented: true, usedIo: true, state: { seen: [1] }
  });
  let row = await dbTriggerStore.read("linear", "PRG-1");
  assert.equal(row?.errorStreak, 2);
  assert.deepEqual(row?.state, { seen: [1] });
  assert.equal(row?.usedIo, true);

  await dbTriggerStore.saveCompiled({ tracker: "linear", identifier: "PRG-1", proseHash: "h2", status: "ok", code: "x", intervalSec: 120 }, now);
  row = await dbTriggerStore.read("linear", "PRG-1");
  assert.equal(row?.proseHash, "h2");
  assert.equal(row?.errorStreak, 0);
  assert.equal(row?.errorCommented, false);
  assert.equal(row?.state, null);
  assert.equal(row?.usedIo, false);
  assert.equal(row?.lastCheckAt?.toISOString(), now.toISOString());
  assert.equal(row?.nextCheckAt?.toISOString(), now.toISOString());
});

test("recordCheck leaves state/usedIo alone when omitted", async () => {
  const now = new Date("2026-10-07T10:00:00Z");
  await dbTriggerStore.saveCompiled({ tracker: "linear", identifier: "PRG-2", proseHash: "h", status: "ok", code: "x", intervalSec: 60 }, now);
  await dbTriggerStore.recordCheck("linear", "PRG-2", { lastCheckAt: now, nextCheckAt: now, lastOutcome: "no-fire", usedIo: true, state: { a: 1 } });
  await dbTriggerStore.recordCheck("linear", "PRG-2", { lastCheckAt: now, nextCheckAt: now, lastOutcome: "skipped:busy" });
  const row = await dbTriggerStore.read("linear", "PRG-2");
  assert.deepEqual(row?.state, { a: 1 });
  assert.equal(row?.usedIo, true);
  assert.equal(row?.lastOutcome, "skipped:busy");
});

test("remove deletes the row", async () => {
  await dbTriggerStore.remove("linear", "PRG-2");
  assert.equal(await dbTriggerStore.read("linear", "PRG-2"), null);
});
