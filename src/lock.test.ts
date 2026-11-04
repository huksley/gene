import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCK_DIR } from "./config.ts";
import { isHeldByLiveProcess } from "./lock.ts";

const writeLock = (id: string, pid: number, acquiredAt: number): string => {
  mkdirSync(LOCK_DIR, { recursive: true });
  const file = path.join(LOCK_DIR, `${id}.lock`);
  writeFileSync(file, JSON.stringify({ pid, acquiredAt }));
  return file;
};

test("isHeldByLiveProcess: a lock held by a running process, however old", () => {
  const file = writeLock("TEST-LOCK-LIVE", process.pid, Date.now() - 2 * 60 * 60 * 1000);
  try {
    assert.equal(isHeldByLiveProcess("TEST-LOCK-LIVE"), true);
  } finally {
    rmSync(file, { force: true });
  }
});

test("isHeldByLiveProcess: no lock, or one left by a dead process", () => {
  assert.equal(isHeldByLiveProcess("TEST-LOCK-NONE"), false);
  const file = writeLock("TEST-LOCK-DEAD", 2 ** 22 + 12345, Date.now());
  try {
    assert.equal(isHeldByLiveProcess("TEST-LOCK-DEAD"), false);
  } finally {
    rmSync(file, { force: true });
  }
});
