import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "./prompt.ts";
import { env } from "./config.ts";
import type { Issue, Comment } from "./tracker/index.ts";

const program: Issue = {
  id: "id-PRG-1",
  identifier: "PRG-1",
  title: "Nightly CI triage",
  description: "## Trigger\nManual\n## Workflow\nCheck CI, retry flaky.\n## Acceptance criteria\nComment a summary.",
  url: "https://example/PRG-1",
  branchName: "PRG-1",
  stateName: "Todo",
  updatedAt: "2026-08-16T00:00:00.000Z",
  assigneeName: null,
  assigneeIsMe: true,
  assigneeMatch: null,
  teamKey: "ENG",
  teamName: "Engineering",
  projectName: null
};
const comments: Comment[] = [];

test("program prompt: repo-less run has no change-request instructions", () => {
  const p = buildPrompt({
    issue: program,
    comments,
    worktreePath: "/tmp/.gene/programs/PRG-1",
    intent: "program",
    attachmentRelativePaths: [],
    hasRepo: false
  });
  assert.match(p, /## Workflow/);
  assert.match(p, /## Acceptance criteria/);
  assert.match(p, /never open a change request/i);
  assert.doesNotMatch(p, /How to open the/i);
  assert.doesNotMatch(p, /git push/i);
});

test("program prompt: with a repo, still no change request but mentions the working tree", () => {
  const p = buildPrompt({
    issue: program,
    comments,
    worktreePath: "/repo/worktree",
    intent: "program",
    attachmentRelativePaths: [],
    hasRepo: true
  });
  assert.match(p, /never open a change request/i);
  assert.match(p, /working/i);
});

test("program prompt includes why a trigger fired", () => {
  const prompt = buildPrompt({
    issue: program,
    comments: [],
    worktreePath: "/tmp/.gene/programs/PRG-1",
    intent: "program",
    attachmentRelativePaths: [],
    hasRepo: false,
    fireReason: "!87, !91 need rebase"
  });
  assert.match(prompt, /# Why this run fired/);
  assert.match(prompt, /!87, !91 need rebase/);
});

test("program prompt omits the trigger section for a manual fire", () => {
  const prompt = buildPrompt({
    issue: program,
    comments: [],
    worktreePath: "/tmp/.gene/programs/PRG-1",
    intent: "program",
    attachmentRelativePaths: [],
    hasRepo: false
  });
  assert.doesNotMatch(prompt, /Why this run fired/);
});

test("program prompt on a resume carries the agent's question and the human's reply", () => {
  const exchange: Comment[] = [
    { id: "q", body: "Which cluster should I scan? #gene-ai", createdAt: "2026-11-03T08:00:00.000Z", authorName: "ruslan", isAgent: true },
    { id: "r", body: "Use the staging cluster", createdAt: "2026-11-03T09:00:00.000Z", authorName: "ruslan", isAgent: false }
  ];
  const prompt = buildPrompt({
    issue: program,
    comments: exchange,
    worktreePath: "/tmp/.gene/programs/PRG-1",
    intent: "program",
    attachmentRelativePaths: [],
    hasRepo: false,
    conversation: exchange
  });
  assert.match(prompt, /Which cluster should I scan\?/);
  assert.match(prompt, /Use the staging cluster/);
});

test("a fresh program run's prompt carries no comments", () => {
  const prompt = buildPrompt({
    issue: program,
    comments: [
      { id: "old", body: "Run report: all quiet", createdAt: "2026-11-02T08:00:00.000Z", authorName: "ruslan", isAgent: true }
    ],
    worktreePath: "/tmp/.gene/programs/PRG-1",
    intent: "program",
    attachmentRelativePaths: [],
    hasRepo: false
  });
  assert.doesNotMatch(prompt, /Run report: all quiet/);
});

test("program prompt tells the run where to write its notes", () => {
  const prompt = buildPrompt({
    issue: program,
    comments: [],
    worktreePath: "/tmp/.gene/programs/PRG-1",
    intent: "program",
    attachmentRelativePaths: [],
    hasRepo: false,
    runNotesPath: "/tmp/.gene/programs/PRG-1/.gene-run-notes.md"
  });
  assert.match(prompt, /\/tmp\/\.gene\/programs\/PRG-1\/\.gene-run-notes\.md/);
});

// Gene tells its own comments from a human's only by the marker. A program agent's
// unmarked question reads as a human reply, so a Blocked program resumed itself.
test("program prompt tells the agent to mark every comment it posts", () => {
  const prompt = buildPrompt({
    issue: program,
    comments: [],
    worktreePath: "/tmp/.gene/programs/PRG-1",
    intent: "program",
    attachmentRelativePaths: [],
    hasRepo: false
  });
  assert.ok(prompt.includes(env.AGENT_MARKER), "the marker itself is in the prompt");
  assert.match(prompt, /end every comment/i);
});
