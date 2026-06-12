import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyTrelloSignature, isRelevantTrelloAction } from "./webhook.ts";

const sign = (body: string, callbackUrl: string, secret: string): string =>
  crypto.createHmac("sha1", secret).update(body + callbackUrl).digest("base64");

test("verifyTrelloSignature accepts a correctly-signed body", () => {
  const body = JSON.stringify({ action: { type: "commentCard" } });
  const url = "https://tunnel.example/gene";
  const secret = "s3cret";
  assert.equal(verifyTrelloSignature(body, url, sign(body, url, secret), secret), true);
});

test("verifyTrelloSignature rejects a tampered body", () => {
  const url = "https://tunnel.example/gene";
  const secret = "s3cret";
  const sig = sign(JSON.stringify({ action: { type: "commentCard" } }), url, secret);
  assert.equal(verifyTrelloSignature(JSON.stringify({ action: { type: "updateCard" } }), url, sig, secret), false);
});

test("verifyTrelloSignature rejects a wrong secret", () => {
  const body = "{}";
  const url = "https://tunnel.example/gene";
  assert.equal(verifyTrelloSignature(body, url, sign(body, url, "right"), "wrong"), false);
});

test("verifyTrelloSignature rejects garbage without throwing", () => {
  assert.equal(verifyTrelloSignature("{}", "https://x", "not-base64-of-right-length", "s"), false);
});

test("isRelevantTrelloAction filters to card-activity types", () => {
  assert.equal(isRelevantTrelloAction("commentCard"), true);
  assert.equal(isRelevantTrelloAction("updateCard"), true);
  assert.equal(isRelevantTrelloAction("createCard"), true);
  assert.equal(isRelevantTrelloAction("updateBoard"), false);
});
