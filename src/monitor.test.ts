import { test } from "node:test";
import assert from "node:assert/strict";
import { monitor, DONE_STAGE } from "./monitor.ts";

// node --test isolates each test file in its own process, so the `monitor`
// singleton starts empty here; these two tests share it and run in order.

const tot = () => {
  const { in: i, out: o, total } = monitor.getState().tokens;
  return { in: i, out: o, total };
};

test("running total = seeded lifetime base + live session agents", () => {
  monitor.seedLifetimeTokens({ in: 1000, out: 50 });
  assert.deepEqual(tot(), { in: 1000, out: 50, total: 1050 }); // base only, no agents yet

  monitor.agentTokens("TOK-A", { in: 200, out: 30, total: 230 });
  monitor.agentTokens("TOK-B", { in: 100, out: 20, total: 120 });
  assert.deepEqual(tot(), { in: 1300, out: 100, total: 1400 });
});

test("re-seeding replaces the base (not additive); session agents still counted once", () => {
  monitor.seedLifetimeTokens({ in: 0, out: 0 }); // TOK-A + TOK-B persist in the session map
  assert.deepEqual(tot(), { in: 300, out: 50, total: 350 });
});

test("markIssueDone replaces a stale dispatch stage with 'done' on an existing row", () => {
  monitor.agentDispatched("DONE-1", "start-processing", "repo");
  assert.equal(monitor.getAgent("DONE-1")?.stage, "start-processing");
  monitor.markIssueDone("DONE-1");
  assert.equal(monitor.getAgent("DONE-1")?.stage, DONE_STAGE);
});

test("markIssueDone never creates a row for a ticket that never ran", () => {
  monitor.markIssueDone("NEVER-RAN");
  assert.equal(monitor.getAgent("NEVER-RAN"), undefined);
});

test("setIssueState records the issue's current tracker state on an existing row", () => {
  monitor.agentDispatched("STATE-1", "start-processing", "repo");
  monitor.setIssueState("STATE-1", "In Review");
  assert.equal(monitor.getAgent("STATE-1")?.lifecycleState, "In Review");
  monitor.setIssueState("STATE-1", "Done");
  assert.equal(monitor.getAgent("STATE-1")?.lifecycleState, "Done");
});

test("setIssueState never creates a row for a ticket that never ran", () => {
  monitor.setIssueState("STATE-GHOST", "In Progress");
  assert.equal(monitor.getAgent("STATE-GHOST"), undefined);
});
