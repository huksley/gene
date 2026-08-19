import { test } from "node:test";
import assert from "node:assert/strict";
import { safeRestingState } from "./program-state.ts";

test("safeRestingState returns the recorded resting state", () => {
  assert.equal(safeRestingState("Backlog", "Done", "Todo"), "Backlog");
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
