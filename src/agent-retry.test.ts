import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesTransient, isRetriable } from "./agent-retry.ts";

test("matchesTransient flags known dropped-socket / API-transport signatures", () => {
  assert.equal(matchesTransient("API Error: socket connection was closed unexpectedly"), true);
  assert.equal(matchesTransient("request failed with ECONNRESET"), true);
  assert.equal(matchesTransient("TypeError: fetch failed"), true);
  assert.equal(matchesTransient("upstream connect error or disconnect"), true);
});

test("matchesTransient ignores ordinary assistant prose", () => {
  assert.equal(matchesTransient("I fixed the failing test and opened the PR."), false);
  assert.equal(matchesTransient("The socket module needs a refactor."), false);
});

test("isRetriable: turn-limit is never retried", () => {
  assert.equal(isRetriable(1, "error_max_turns", false), false);
  assert.equal(isRetriable(0, "error_max_turns", false), false);
});

test("isRetriable: any non-zero exit retries (unless turn-limit)", () => {
  assert.equal(isRetriable(1, "error", false), true);
  assert.equal(isRetriable(-1, undefined, false), true);
});

test("isRetriable: clean exit-0 success does NOT retry", () => {
  assert.equal(isRetriable(0, "success", false), false);
});

test("isRetriable: exit-0 silent crash (no success result) retries", () => {
  assert.equal(isRetriable(0, undefined, false), true);
});

test("isRetriable: exit-0 with a transient signature retries", () => {
  assert.equal(isRetriable(0, "success", true), true);
});
