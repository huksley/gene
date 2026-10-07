import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTriggerLine } from "./trigger-line.ts";

const now = Date.parse("2026-10-07T08:59:30Z");

test("ok trigger line", () => {
  const line = formatTriggerLine(
    { status: "ok", summary: "Hourly", intervalSec: 60, nextCheckAt: now + 30_000, lastCheckAt: now - 30_000, lastOutcome: "no-fire" },
    now
  );
  assert.equal(line, "⚡ Hourly · every 1m 00s · next in 30s · last: no fire");
});

test("skipped and fired outcomes read plainly", () => {
  assert.match(formatTriggerLine({ status: "ok", summary: "S", lastOutcome: "skipped:cooldown" }, now), /last: skipped \(cooldown\)$/);
  assert.match(formatTriggerLine({ status: "ok", summary: "S", lastOutcome: "fire", lastReason: "!87" }, now), /last: fired — !87$/);
  assert.match(formatTriggerLine({ status: "ok", summary: "S", nextCheckAt: now - 1 }, now), /· due ·/);
});

test("compiling / uncompilable / error lines", () => {
  assert.equal(formatTriggerLine({ status: "compiling" }, now), "⟳ compiling trigger…");
  assert.equal(formatTriggerLine({ status: "uncompilable", error: "no schedule" }, now), "⚠ trigger not compiled: no schedule");
  assert.match(formatTriggerLine({ status: "ok", summary: "Hourly", lastOutcome: "error", lastReason: "boom" }, now), /last: error — boom/);
});
