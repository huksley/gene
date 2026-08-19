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
  monitor.agentDispatched("DONE-1", "processing", "repo");
  assert.equal(monitor.getAgent("DONE-1")?.stage, "processing");
  monitor.markIssueDone("DONE-1");
  assert.equal(monitor.getAgent("DONE-1")?.stage, DONE_STAGE);
});

test("markIssueDone never creates a row for a ticket that never ran", () => {
  monitor.markIssueDone("NEVER-RAN");
  assert.equal(monitor.getAgent("NEVER-RAN"), undefined);
});

test("setIssueState tracks an issue's current tracker state in the side-map", () => {
  monitor.agentDispatched("STATE-1", "processing", "repo");
  monitor.setIssueState("STATE-1", "In Review");
  assert.equal(monitor.getIssueState("STATE-1"), "In Review");
  monitor.setIssueState("STATE-1", "Done");
  assert.equal(monitor.getIssueState("STATE-1"), "Done");
});

test("setIssueState records state without conjuring an agent row", () => {
  monitor.setIssueState("STATE-GHOST", "In Progress");
  assert.equal(monitor.getIssueState("STATE-GHOST"), "In Progress");
  assert.equal(monitor.getAgent("STATE-GHOST"), undefined);
});

test("setProgramRow creates an idle, program-flagged row", () => {
  monitor.setProgramRow("PRG-1", "Nightly triage", "Todo");
  const row = monitor.getState().agents.find(a => a.id === "PRG-1");
  assert.ok(row);
  assert.equal(row!.isProgram, true);
  assert.equal(row!.stage, "program");
  assert.equal(row!.status, "idle");
  assert.equal(row!.lifecycleState, "Todo");
});

test("setProgramRow does not downgrade a running program to idle", () => {
  monitor.agentDispatched("PRG-2", "program", "(no repo)", undefined, "Running one");
  monitor.agentSpawned("PRG-2", 12345, () => {}); // flips the row to "running"
  monitor.setProgramRow("PRG-2", "Running one", "In Progress");
  const row = monitor.getState().agents.find(a => a.id === "PRG-2");
  assert.ok(row);
  assert.equal(row!.isProgram, true);
  assert.notEqual(row!.status, "idle"); // stays running, not reset to idle
});
