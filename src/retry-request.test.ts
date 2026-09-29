import { test } from "node:test";
import assert from "node:assert/strict";
import { requestRetry, takeRetryRequest } from "./retry-request.ts";

test("takeRetryRequest consumes a queued retry exactly once (case-insensitive)", () => {
  requestRetry("CLOUD-1");
  requestRetry("cloud-1");
  assert.equal(takeRetryRequest("Cloud-1"), true);
  assert.equal(takeRetryRequest("CLOUD-1"), false);
});

test("takeRetryRequest is false for a ticket with no request", () => {
  assert.equal(takeRetryRequest("CLOUD-2"), false);
});
