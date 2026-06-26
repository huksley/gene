import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseNotesSummary } from "./update.ts";

test("releaseNotesSummary keeps the first two paragraphs and drops the rest", () => {
  const body = [
    "## What's Changed",
    "* feat: allow WebFetch by @huksley in #12",
    "",
    "**Full Changelog**: https://github.com/huksley/gene/compare/v1.2.2...v1.2.5",
    "",
    "## New Contributors",
    "* @someone made their first contribution"
  ].join("\n");

  assert.equal(
    releaseNotesSummary(body),
    "## What's Changed\n* feat: allow WebFetch by @huksley in #12\n\n" +
      "**Full Changelog**: https://github.com/huksley/gene/compare/v1.2.2...v1.2.5"
  );
});

test("releaseNotesSummary normalizes CRLF and collapses blank-line runs", () => {
  const body = "First para\r\n\r\n\r\nSecond para\r\n\r\nThird para";
  assert.equal(releaseNotesSummary(body), "First para\n\nSecond para");
});

test("releaseNotesSummary respects a custom paragraph count", () => {
  const body = "one\n\ntwo\n\nthree";
  assert.equal(releaseNotesSummary(body, 1), "one");
  assert.equal(releaseNotesSummary(body, 3), "one\n\ntwo\n\nthree");
});

test("releaseNotesSummary returns empty string when there is nothing to show", () => {
  assert.equal(releaseNotesSummary(undefined), "");
  assert.equal(releaseNotesSummary(null), "");
  assert.equal(releaseNotesSummary(""), "");
  assert.equal(releaseNotesSummary("   \n\n  \t \n"), "");
});
