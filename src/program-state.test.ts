import { test } from "node:test";
import assert from "node:assert/strict";
import { safeRestingState } from "./program-state.ts";

test("safeRestingState returns the recorded resting state", () => {
  assert.equal(safeRestingState("Backlog", "Done", "Todo"), "Backlog");
});

// Regression (CLOUD-2014): a fire while the ticket already read ACTIVE recorded
// "In Progress" as the resting state, so every finished run "restored" the program to
// the very state that makes the next scan resume it — an unbreakable re-fire loop.
// A resting state can never be the state that means "running".
test("safeRestingState never returns the active state", () => {
  assert.equal(safeRestingState("In Progress", "Done", "Todo", "In Progress"), "Todo");
});

test("safeRestingState keeps a non-active resting state when active is given", () => {
  assert.equal(safeRestingState("Blocked", "Done", "Todo", "In Progress"), "Blocked");
});

test("safeRestingState never returns the Done state", () => {
  assert.equal(safeRestingState("Done", "Done", "Todo"), "Todo");
});

test("safeRestingState falls back to trigger when resting is missing", () => {
  assert.equal(safeRestingState(undefined, "Done", "Todo"), "Todo");
});

test("safeRestingState with Done unset still returns a real resting state", () => {
  assert.equal(safeRestingState("In Review", undefined, "Todo"), "In Review");
});
