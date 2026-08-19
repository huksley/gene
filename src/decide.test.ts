import { test } from "node:test";
import assert from "node:assert/strict";
import { findMissingSections } from "./decide.ts";

const PROGRAM_SECTIONS = ["## Trigger", "## Workflow", "## Acceptance criteria"];

test("findMissingSections: all program sections present and non-empty → none missing", () => {
  const desc = [
    "## Trigger",
    "Manual fire.",
    "## Workflow",
    "Do the thing.",
    "## Acceptance criteria",
    "It is done."
  ].join("\n");
  assert.deepEqual(findMissingSections(desc, PROGRAM_SECTIONS), []);
});

test("findMissingSections: a missing heading is reported", () => {
  const desc = "## Trigger\nx\n## Acceptance criteria\ny";
  assert.deepEqual(findMissingSections(desc, PROGRAM_SECTIONS), ["## Workflow"]);
});

test("findMissingSections: a present-but-empty section is reported", () => {
  const desc = "## Trigger\nx\n## Workflow\n\n## Acceptance criteria\ny";
  assert.deepEqual(findMissingSections(desc, PROGRAM_SECTIONS), ["## Workflow"]);
});

test("findMissingSections: empty description reports all", () => {
  assert.deepEqual(findMissingSections("", PROGRAM_SECTIONS), PROGRAM_SECTIONS);
});
