import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "./prompt.ts";
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
