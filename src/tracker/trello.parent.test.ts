import { test } from "node:test";
import assert from "node:assert/strict";
import { parentIdentifierFromDesc } from "./trello.ts";

test("parses the parent shortLink from a leading Parent: line", () => {
  const desc = "Parent: https://trello.com/c/AbCd1234\n\n## Problem\nsomething";
  assert.equal(parentIdentifierFromDesc(desc), "AbCd1234");
});

test("tolerates a www. host and trailing path segments", () => {
  const desc = "Parent: https://www.trello.com/c/Zz99XxYy/12-some-slug\n\nbody";
  assert.equal(parentIdentifierFromDesc(desc), "Zz99XxYy");
});

test("matches a Parent: line even when not the very first line", () => {
  const desc = "  \nParent: https://trello.com/c/QqWwEe11\nbody";
  assert.equal(parentIdentifierFromDesc(desc), "QqWwEe11");
});

test("returns undefined when there is no Parent marker", () => {
  assert.equal(parentIdentifierFromDesc("## Problem\njust a normal card"), undefined);
});

test("returns undefined for an empty description", () => {
  assert.equal(parentIdentifierFromDesc(""), undefined);
});

test("ignores a bare 'Parent:' without a card URL", () => {
  assert.equal(parentIdentifierFromDesc("Parent: see the other card"), undefined);
});
