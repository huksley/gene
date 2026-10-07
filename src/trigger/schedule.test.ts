import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTrigger, effectiveIntervalMs, parseDurationSec } from "./schedule.ts";

const now = new Date("2026-10-07T09:00:00Z");
const min = 60_000;

test("not due before next_check_at", () => {
  assert.deepEqual(decideTrigger({ now, nextCheckAt: new Date(now.getTime() + 1), resting: true, cooldownMs: 30 * min }), { kind: "not-due" });
});

test("due with no next_check_at", () => {
  assert.deepEqual(decideTrigger({ now, resting: true, cooldownMs: 30 * min }), { kind: "run" });
});

test("busy beats cooldown", () => {
  assert.deepEqual(
    decideTrigger({ now, nextCheckAt: now, resting: false, lastFiredAt: now, cooldownMs: 30 * min }),
    { kind: "skip", reason: "busy" }
  );
});

test("cooldown measured from last fire of any source", () => {
  const recent = new Date(now.getTime() - 29 * min);
  const old = new Date(now.getTime() - 31 * min);
  assert.deepEqual(decideTrigger({ now, nextCheckAt: now, resting: true, lastFiredAt: recent, cooldownMs: 30 * min }), { kind: "skip", reason: "cooldown" });
  assert.deepEqual(decideTrigger({ now, nextCheckAt: now, resting: true, lastFiredAt: old, cooldownMs: 30 * min }), { kind: "run" });
});

test("interval clamps to [poll, 24h]", () => {
  const base = { usedIo: false, errorStreak: 0, pollMs: min, ioFloorMs: 5 * min };
  assert.equal(effectiveIntervalMs({ ...base, intervalSec: 10 }), min);
  assert.equal(effectiveIntervalMs({ ...base, intervalSec: 7 * 86400 }), 86_400_000);
  assert.equal(effectiveIntervalMs({ ...base, intervalSec: undefined }), min);
});

test("io floor applies only after an IO run", () => {
  const base = { intervalSec: 60, errorStreak: 0, pollMs: min, ioFloorMs: 5 * min };
  assert.equal(effectiveIntervalMs({ ...base, usedIo: false }), min);
  assert.equal(effectiveIntervalMs({ ...base, usedIo: true }), 5 * min);
});

test("error backoff doubles, capped at 1h, never shortens a long interval", () => {
  const base = { usedIo: false, pollMs: min, ioFloorMs: 5 * min };
  assert.equal(effectiveIntervalMs({ ...base, intervalSec: 300, errorStreak: 1 }), 10 * min);
  assert.equal(effectiveIntervalMs({ ...base, intervalSec: 300, errorStreak: 10 }), 60 * min);
  assert.equal(effectiveIntervalMs({ ...base, intervalSec: 86400, errorStreak: 3 }), 86_400_000);
});

test("parseDurationSec", () => {
  assert.equal(parseDurationSec("90s"), 90);
  assert.equal(parseDurationSec("15m"), 900);
  assert.equal(parseDurationSec(" 1h "), 3600);
  assert.equal(parseDurationSec("1d"), 86400);
  assert.equal(parseDurationSec("soon"), undefined);
  assert.equal(parseDurationSec("0m"), undefined);
});
