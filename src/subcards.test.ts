import { test } from "node:test";
import assert from "node:assert/strict";
import { parentsToComplete, isParentAwaitingChildren } from "./subcards.ts";
import type { Issue } from "./tracker/index.ts";

const DONE = "Done";

/** Minimal Issue factory — only the fields subcards.ts reads. */
const issue = (identifier: string, stateName: string, parentIdentifier?: string): Issue => ({
  id: `id-${identifier}`,
  identifier,
  title: identifier,
  description: "",
  url: `https://trello.com/c/${identifier}`,
  branchName: `gene/${identifier}`,
  stateName,
  updatedAt: "",
  assigneeName: null,
  assigneeIsMe: true,
  assigneeMatch: null,
  teamKey: "",
  teamName: "",
  projectName: null,
  parentIdentifier
});

test("parent completes when all children are in the done state", () => {
  const issues = [
    issue("P", "Blocked"),
    issue("A", DONE, "P"),
    issue("B", DONE, "P")
  ];
  const out = parentsToComplete(issues, DONE);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.parent.identifier, "P");
  assert.deepEqual(out[0]!.children.map(c => c.identifier).sort(), ["A", "B"]);
});

test("parent does not complete while a child is still open", () => {
  const issues = [issue("P", "Blocked"), issue("A", DONE, "P"), issue("B", "In Progress", "P")];
  assert.deepEqual(parentsToComplete(issues, DONE), []);
});

test("a parent already in the done state is a no-op", () => {
  const issues = [issue("P", DONE), issue("A", DONE, "P")];
  assert.deepEqual(parentsToComplete(issues, DONE), []);
});

test("a dangling parentIdentifier (no matching parent) is skipped", () => {
  const issues = [issue("A", DONE, "GHOST"), issue("B", DONE, "GHOST")];
  assert.deepEqual(parentsToComplete(issues, DONE), []);
});

test("a parent with no children is never auto-completed", () => {
  const issues = [issue("P", "Blocked")];
  assert.deepEqual(parentsToComplete(issues, DONE), []);
});

test("multiple independent parents are each evaluated", () => {
  const issues = [
    issue("P1", "Blocked"),
    issue("A", DONE, "P1"),
    issue("P2", "Blocked"),
    issue("B", "In Progress", "P2")
  ];
  const out = parentsToComplete(issues, DONE);
  assert.deepEqual(out.map(g => g.parent.identifier), ["P1"]);
});

test("isParentAwaitingChildren is true for a parent with an open child", () => {
  const issues = [issue("P", "Blocked"), issue("A", "In Progress", "P")];
  assert.equal(isParentAwaitingChildren(issue("P", "Blocked"), issues, DONE), true);
});

test("isParentAwaitingChildren is false once every child is done", () => {
  const issues = [issue("P", "Blocked"), issue("A", DONE, "P")];
  assert.equal(isParentAwaitingChildren(issue("P", "Blocked"), issues, DONE), false);
});

test("isParentAwaitingChildren is false for a leaf issue with no children", () => {
  const issues = [issue("X", "In Progress")];
  assert.equal(isParentAwaitingChildren(issue("X", "In Progress"), issues, DONE), false);
});
