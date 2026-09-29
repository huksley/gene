import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesTransient, matchesAuthFailure, isRetriable } from "./agent-retry.ts";

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

test("matchesAuthFailure flags the CLI's login-expired / bad-key output", () => {
  assert.equal(matchesAuthFailure("Failed to authenticate: OAuth session expired and could not be refreshed"), true);
  assert.equal(matchesAuthFailure("Invalid API key · Please run /login"), true);
  assert.equal(matchesAuthFailure("OAuth token has expired. Please obtain a new token or refresh your existing token."), true);
  assert.equal(matchesAuthFailure("API Error: 401 {\"type\":\"error\"}"), true);
});

test("matchesAuthFailure ignores prose about auth code", () => {
  assert.equal(matchesAuthFailure("The login handler returns 'Failed to authenticate' on a bad password."), false);
  assert.equal(matchesAuthFailure("I added a 401 check to the API client."), false);
});

test("isRetriable: an auth failure is never retried", () => {
  assert.equal(isRetriable(1, "error", false, true), false);
  assert.equal(isRetriable(0, undefined, false, true), false);
  assert.equal(isRetriable(0, "success", true, true), false);
});
