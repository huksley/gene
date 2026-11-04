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
  extractProgramSections,
  programBranch,
  planProgramEnding,
  resumeExchange,
  replaceRunNotes
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

test("decide: ACTIVE, nothing running, an unfinished run on record → resume-interrupted", () => {
  const a = decideProgramAction(prog(env.ACTIVE_STATE), [], {
    firePending: false,
    runInFlight: false,
    interruptedRun: true
  });
  assert.equal(a.kind, "resume-interrupted");
});

// Regression (CLOUD-2014, 419 dispatches from 6 fires): ACTIVE with nothing running is
// NOT on its own evidence of an interrupted run — it is also what a program looks like
// the instant a finished run "restored" it to a resting state that was itself ACTIVE, or
// after something else (a coding dispatch, an operator) parked it there. Resuming on that
// inference alone re-fires the program every poll, forever. Instead it is put back to rest
// (Todo) — never re-run — so its trigger is armed again (CLOUD-2629 sat In Progress for a
// month with its trigger off).
test("decide: ACTIVE, nothing running, no unfinished run on record → rest, not a re-run", () => {
  const a = decideProgramAction(prog(env.ACTIVE_STATE), [], {
    firePending: false,
    runInFlight: false,
    interruptedRun: false
  });
  assert.equal(a.kind, "rest");
});

test("decide: ACTIVE and running → nothing", () => {
  const a = decideProgramAction(prog(env.ACTIVE_STATE), [], {
    firePending: false,
    runInFlight: true,
    interruptedRun: false
  });
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
  assert.equal(takeFireRequest("PRG-9")?.source, "manual");
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

test("takeFireRequest returns source and reason, once", () => {
  fireProgram("PRG-R1", "trigger", "!87 needs rebase");
  assert.deepEqual(takeFireRequest("prg-r1"), { source: "trigger", reason: "!87 needs rebase" });
  assert.equal(takeFireRequest("PRG-R1"), undefined);
});

test("manual fire has no reason", () => {
  fireProgram("PRG-R2");
  assert.deepEqual(takeFireRequest("PRG-R2"), { source: "manual", reason: undefined });
});

test("programBranch: reads the ## Branch section, stripping backticks and origin/", () => {
  assert.equal(programBranch("## Workflow\ndo it\n\n## Branch\n`release/2.x`\n"), "release/2.x");
  assert.equal(programBranch("## Branch\n\n  origin/develop  \n## Workflow\nx"), "develop");
});

test("programBranch: absent or empty section → undefined", () => {
  assert.equal(programBranch("## Workflow\ndo it"), undefined);
  assert.equal(programBranch("## Branch\n\n## Workflow\nx"), undefined);
});

// --- Where a run ends up ------------------------------------------------------------
const okRun = { exitCode: 0, sawSuccessResult: true, transientFailure: false, authFailure: false };

test("ending: a finished run goes back to Todo with no extra comment", () => {
  const plan = planProgramEnding({ kind: "finished", result: okRun, liveState: env.ACTIVE_STATE });
  assert.equal(plan.moveTo, env.TRIGGER_STATE);
  assert.equal(plan.lastResult, "ok");
  assert.equal(plan.comment, undefined);
});

test("ending: a run the agent parked in Blocked stays there", () => {
  const plan = planProgramEnding({ kind: "finished", result: okRun, liveState: env.BLOCKED_STATE });
  assert.equal(plan.moveTo, null);
  assert.equal(plan.lastResult, "blocked");
  assert.equal(plan.comment, undefined);
});

// The agent may have parked it in Blocked; moving it would orphan the question. If it is
// still In Progress, the next scan's sweep returns it to Todo.
test("ending: an unreadable live state leaves the ticket where it is", () => {
  const plan = planProgramEnding({ kind: "finished", result: okRun, liveState: undefined });
  assert.equal(plan.moveTo, null);
});

test("ending: an unreadable live state still explains an incomplete run", () => {
  const plan = planProgramEnding({ kind: "finished", result: { ...okRun, exitCode: 1 }, liveState: undefined });
  assert.equal(plan.moveTo, null);
  assert.match(plan.comment ?? "", /exited with code 1/);
});

test("ending: an incomplete run goes back to Todo and says why on the ticket", () => {
  const plan = planProgramEnding({
    kind: "finished",
    result: { ...okRun, sawSuccessResult: false, transientFailure: true },
    liveState: env.ACTIVE_STATE
  });
  assert.equal(plan.moveTo, env.TRIGGER_STATE);
  assert.equal(plan.lastResult, "incomplete");
  assert.match(plan.comment ?? "", /connection to the model API dropped/);
});

test("ending: a non-zero exit is incomplete and names the exit code", () => {
  const plan = planProgramEnding({ kind: "finished", result: { ...okRun, exitCode: 137 }, liveState: env.ACTIVE_STATE });
  assert.equal(plan.lastResult, "incomplete");
  assert.match(plan.comment ?? "", /137/);
});

test("ending: a run whose claude couldn't log in is incomplete and says so", () => {
  const plan = planProgramEnding({
    kind: "finished",
    result: { ...okRun, sawSuccessResult: false, authFailure: true },
    liveState: env.ACTIVE_STATE
  });
  assert.equal(plan.lastResult, "incomplete");
  assert.match(plan.comment ?? "", /claude \/login/);
});

// A plain dashboard cancel used to leave the program In Progress forever (the code
// expected a re-fire that only a restart queues), disarming its trigger.
test("ending: a plain cancel goes back to Todo", () => {
  const plan = planProgramEnding({ kind: "cancelled", refirePending: false });
  assert.equal(plan.moveTo, env.TRIGGER_STATE);
  assert.equal(plan.lastResult, "cancelled");
});

test("ending: a cancel for a restart stays In Progress for the re-fire", () => {
  const plan = planProgramEnding({ kind: "cancelled", refirePending: true });
  assert.equal(plan.moveTo, null);
  assert.equal(plan.lastResult, "cancelled");
});

test("ending: Gene crashing mid-run goes back to Todo and posts the error", () => {
  const plan = planProgramEnding({ kind: "crashed", error: "linear api error: rate limited" });
  assert.equal(plan.moveTo, env.TRIGGER_STATE);
  assert.equal(plan.lastResult, "error");
  assert.match(plan.comment ?? "", /linear api error: rate limited/);
});

test("ending: a failed branch sync parks in Blocked with the reason", () => {
  const plan = planProgramEnding({ kind: "branch-sync-failed", reason: "couldn't find remote ref release/9" });
  assert.equal(plan.moveTo, env.BLOCKED_STATE);
  assert.equal(plan.lastResult, "blocked");
  assert.match(plan.comment ?? "", /couldn't find remote ref release\/9/);
});

test("resumeExchange: Gene's latest comment and the replies after it, nothing older", () => {
  const comments = [
    comment("report", true, "2026-11-01T08:00:00.000Z", "Run report"),
    comment("aside", false, "2026-11-01T09:00:00.000Z", "nice"),
    comment("question", true, "2026-11-03T08:00:00.000Z", "Which cluster?"),
    comment("reply", false, "2026-11-03T09:00:00.000Z", "staging")
  ];
  assert.deepEqual(resumeExchange(comments).map(c => c.id), ["question", "reply"]);
});

// --- Run notes ----------------------------------------------------------------------
test("replaceRunNotes: swaps the section body and leaves the program's sections alone", () => {
  const desc = "## Trigger\nDaily.\n\n## Run notes\n\nLast SHA: aaa\n\n## Workflow\nReview.\n";
  assert.equal(
    replaceRunNotes(desc, "Last SHA: bbb"),
    "## Trigger\nDaily.\n\n## Run notes\n\nLast SHA: bbb\n\n## Workflow\nReview.\n"
  );
});

test("replaceRunNotes: appends the section when the description has none", () => {
  assert.equal(
    replaceRunNotes("## Trigger\nDaily.\n\n## Workflow\nReview.", "Last SHA: bbb"),
    "## Trigger\nDaily.\n\n## Workflow\nReview.\n\n## Run notes\n\nLast SHA: bbb\n"
  );
});

test("replaceRunNotes: the old notes' subheadings are replaced too", () => {
  const desc = "## Workflow\nReview.\n\n## Run notes\n\n### Last run\nSHA aaa\n### Rotation\nA01";
  assert.equal(replaceRunNotes(desc, "SHA bbb"), "## Workflow\nReview.\n\n## Run notes\n\nSHA bbb\n");
});

test("replaceRunNotes: headings in the notes are demoted so they can't pose as program sections", () => {
  const out = replaceRunNotes("## Trigger\nDaily.\n\n## Workflow\nReview.", "## Trigger\nhourly\n# Big\ntext");
  assert.equal(extractProgramSections(out).trigger, "Daily.");
  assert.equal(out, "## Trigger\nDaily.\n\n## Workflow\nReview.\n\n## Run notes\n\n### Trigger\nhourly\n### Big\ntext\n");
});

test("extractProgramSections: a ### subheading with a section's name isn't that section", () => {
  const desc = "## Workflow\nReview.\n\n## Run notes\n\n### Trigger\nfrom notes";
  assert.equal(extractProgramSections(desc).trigger, "");
});

test("replaceRunNotes: unchanged notes leave the description untouched", () => {
  const desc = "## Workflow\nReview.\n\n## Run notes\n\nLast SHA: aaa";
  assert.equal(replaceRunNotes(desc, "Last SHA: aaa\n"), desc);
});

test("replaceRunNotes: code fences in the notes are kept as written", () => {
  const out = replaceRunNotes("## Workflow\nReview.", "Ran:\n```sh\n# list MRs\nglab mr list\n```");
  assert.equal(out, "## Workflow\nReview.\n\n## Run notes\n\nRan:\n```sh\n# list MRs\nglab mr list\n```\n");
});

test("replaceRunNotes: a heading with trailing text is still the notes section", () => {
  assert.equal(
    replaceRunNotes("## Run notes (kept by Gene)\n\nold\n\n## Workflow\nReview.", "new"),
    "## Run notes\n\nnew\n\n## Workflow\nReview."
  );
});
