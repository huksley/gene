import { test } from "node:test";
import assert from "node:assert/strict";
import type { Issue, Comment } from "./tracker/index.ts";
import { env } from "./config.ts";
import {
  excludePrograms,
  decideProgramAction,
  fireProgram,
  hasFireRequest,
  takeFireRequest,
  childTicketIds,
  newChildIdentifiers,
  extractProgramSections
} from "./programs.ts";

/** Minimal Issue factory — mirrors src/subcards.test.ts's real Issue shape. */
const issue = (identifier: string): Issue => ({
  id: `id-${identifier}`,
  identifier,
  title: identifier,
  description: "",
  url: `https://example/${identifier}`,
  branchName: identifier,
  stateName: "Todo",
  updatedAt: "2026-08-16T00:00:00.000Z",
  assigneeName: null,
  assigneeIsMe: true,
  assigneeMatch: null,
  teamKey: "",
  teamName: "",
  projectName: null
});

test("excludePrograms drops tickets whose identifier is in the program set", () => {
  const all = [issue("ENG-1"), issue("ENG-2"), issue("ENG-3")];
  const out = excludePrograms(all, new Set(["ENG-2"]));
  assert.deepEqual(out.map(i => i.identifier), ["ENG-1", "ENG-3"]);
});

test("excludePrograms with an empty set is a no-op", () => {
  const all = [issue("ENG-1"), issue("ENG-2")];
  assert.deepEqual(excludePrograms(all, new Set()).map(i => i.identifier), ["ENG-1", "ENG-2"]);
});

const prog = (stateName: string): Issue => ({ ...issue("PRG-1"), stateName });
const comment = (id: string, isAgent: boolean, createdAt: string, body = "hi"): Comment => ({
  id,
  body,
  createdAt,
  authorName: isAgent ? "gene" : "human",
  isAgent
});

test("decide: resting program with no fire → nothing", () => {
  const a = decideProgramAction(prog("Todo"), [], { firePending: false, runInFlight: false });
  assert.equal(a.kind, "nothing");
});

test("decide: fire pending, nothing running → fire", () => {
  const a = decideProgramAction(prog("Todo"), [], { firePending: true, source: "manual", runInFlight: false });
  assert.deepEqual(a, { kind: "fire", source: "manual" });
});

test("decide: fire pending while running → restart", () => {
  const a = decideProgramAction(prog(env.ACTIVE_STATE), [], { firePending: true, source: "manual", runInFlight: true });
  assert.deepEqual(a, { kind: "restart", source: "manual" });
});

test("decide: ACTIVE but nothing running locally → resume-interrupted", () => {
  const a = decideProgramAction(prog(env.ACTIVE_STATE), [], { firePending: false, runInFlight: false });
  assert.equal(a.kind, "resume-interrupted");
});

test("decide: ACTIVE and running → nothing", () => {
  const a = decideProgramAction(prog(env.ACTIVE_STATE), [], { firePending: false, runInFlight: true });
  assert.equal(a.kind, "nothing");
});

test("decide: BLOCKED with a new user reply after the agent → resume", () => {
  const comments = [
    comment("c1", true, "2026-08-16T10:00:00.000Z"),
    comment("c2", false, "2026-08-16T11:00:00.000Z", "!gene approve")
  ];
  const a = decideProgramAction(prog(env.BLOCKED_STATE), comments, { firePending: false, runInFlight: false });
  assert.deepEqual(a, { kind: "resume", latestUserCommentId: "c2" });
});

test("decide: BLOCKED with no new reply → nothing", () => {
  const comments = [comment("c1", true, "2026-08-16T10:00:00.000Z")];
  const a = decideProgramAction(prog(env.BLOCKED_STATE), comments, { firePending: false, runInFlight: false });
  assert.equal(a.kind, "nothing");
});

test("decide: BLOCKED with a !gene stop reply → stop", () => {
  const comments = [
    comment("c1", true, "2026-08-16T10:00:00.000Z"),
    comment("c2", false, "2026-08-16T11:00:00.000Z", "!gene stop")
  ];
  const a = decideProgramAction(prog(env.BLOCKED_STATE), comments, { firePending: false, runInFlight: false });
  assert.equal(a.kind, "stop");
});

test("fire queue: enqueue, observe, take-once", () => {
  fireProgram("PRG-9", "manual");
  assert.equal(hasFireRequest("prg-9"), true); // case-insensitive
  assert.equal(takeFireRequest("PRG-9"), "manual");
  assert.equal(takeFireRequest("PRG-9"), undefined); // drained
  assert.equal(hasFireRequest("PRG-9"), false);
});

test("childTicketIds filters by parentIdentifier", () => {
  const kids = [
    { ...issue("K-1"), parentIdentifier: "PRG-1" },
    { ...issue("K-2"), parentIdentifier: "OTHER" },
    { ...issue("K-3"), parentIdentifier: "PRG-1" }
  ] as Issue[];
  assert.deepEqual(childTicketIds(kids, "PRG-1"), ["K-1", "K-3"]);
});

test("newChildIdentifiers returns only ones not already logged", () => {
  assert.deepEqual(newChildIdentifiers(["K-1", "K-2", "K-3"], ["K-1"]), ["K-2", "K-3"]);
});

test("extractProgramSections pulls each section body", () => {
  const desc = "## Trigger\nfire it\n## Workflow\ndo x\ndo y\n## Acceptance criteria\ndone";
  assert.deepEqual(extractProgramSections(desc), {
    trigger: "fire it",
    workflow: "do x\ndo y",
    acceptance: "done"
  });
});

test("extractProgramSections tolerates missing sections", () => {
  assert.deepEqual(extractProgramSections("## Trigger\nx"), { trigger: "x", workflow: "", acceptance: "" });
});
