import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseNotesSummary } from "./update.ts";

test("releaseNotesSummary drops the changelog link and commit trailers", () => {
  const body = [
    "### feat: retry a ticket from the TUI",
    "- `r` inside a ticket retries it",
    "",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "",
    "**Full Changelog**: https://github.com/huksley/gene/compare/v1.3.3...v1.3.4"
  ].join("\n");
  assert.equal(releaseNotesSummary(body), "### feat: retry a ticket from the TUI\n- `r` inside a ticket retries it");
});

test("releaseNotesSummary normalizes CRLF and collapses blank-line runs", () => {
  const body = "First\r\n\r\n\r\nSecond\r\n\r\nThird";
  assert.equal(releaseNotesSummary(body), "First\n\nSecond\n\nThird");
});

test("releaseNotesSummary caps the line count and marks the cut", () => {
  assert.equal(releaseNotesSummary("one\ntwo\nthree", 2), "one\ntwo\n…");
  assert.equal(releaseNotesSummary("one\ntwo", 2), "one\ntwo");
});

test("releaseNotesSummary returns empty string when there is nothing to show", () => {
  assert.equal(releaseNotesSummary(undefined), "");
  assert.equal(releaseNotesSummary(null), "");
  assert.equal(releaseNotesSummary(""), "");
  assert.equal(releaseNotesSummary("   \n\n  \t \n"), "");
  assert.equal(releaseNotesSummary("**Full Changelog**: https://example.com/compare/a...b"), "");
});
