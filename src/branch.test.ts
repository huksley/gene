import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePrefix } from "./branch.ts";

// choosePrefix decides the branch prefix from the issue itself (labels + size),
// independent of the tracker's suggested branch name.

test("a Bug/Fix label forces fix, even for a big issue", () => {
  assert.equal(choosePrefix({ labels: ["Bug"], estimate: 8, description: "x".repeat(2000) }), "fix");
  assert.equal(choosePrefix({ labels: ["Fix"] }), "fix");
});

test("a Feature label forces feature, even for a tiny issue", () => {
  assert.equal(choosePrefix({ labels: ["Feature"], description: "tiny" }), "feature");
});

test("a Fix label wins over a Feature label", () => {
  assert.equal(choosePrefix({ labels: ["Feature", "Bug"] }), "fix");
});

test("label matching is case-insensitive", () => {
  assert.equal(choosePrefix({ labels: ["BUG"] }), "fix");
  assert.equal(choosePrefix({ labels: ["feature"] }), "feature");
});

test("with no decisive label, a set estimate decides: >= 3 is big", () => {
  assert.equal(choosePrefix({ labels: [], estimate: 3 }), "feature");
  assert.equal(choosePrefix({ labels: [], estimate: 5 }), "feature");
});

test("a set-but-small estimate is fix, even with a long description", () => {
  assert.equal(choosePrefix({ labels: [], estimate: 1, description: "x".repeat(2000) }), "fix");
});

test("with no estimate, description length is the fallback (>= 600 chars is big)", () => {
  assert.equal(choosePrefix({ labels: [], description: "x".repeat(600) }), "feature");
  assert.equal(choosePrefix({ labels: [], description: "x".repeat(599) }), "fix");
});

test("nothing decisive — no labels, no estimate, short/empty description — is fix", () => {
  assert.equal(choosePrefix({ labels: [], description: "" }), "fix");
  assert.equal(choosePrefix({ labels: [] }), "fix");
  assert.equal(choosePrefix({ labels: ["Frontend", "Gene"], description: "short" }), "fix");
});
