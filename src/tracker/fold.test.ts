import { test } from "node:test";
import assert from "node:assert/strict";
import { threadsToFold, type ThreadComment } from "./fold.ts";

const RUN_START = "2026-11-04T10:00:00.000Z";
const c = (id: string, createdAt: string, extra: Partial<ThreadComment> = {}): ThreadComment => ({
  id,
  createdAt,
  parentId: null,
  resolved: false,
  ...extra
});

test("folds the threads from before the run, keeps the run's own comments open", () => {
  const comments = [
    c("old-1", "2026-11-03T08:00:00.000Z"),
    c("old-2", "2026-11-03T09:00:00.000Z"),
    c("result", "2026-11-04T10:05:00.000Z")
  ];
  assert.deepEqual(threadsToFold(comments, RUN_START), ["old-1", "old-2"]);
});

test("keeps the ticket's newest comment open even when the run posted nothing", () => {
  const comments = [c("old-1", "2026-11-03T08:00:00.000Z"), c("last-result", "2026-11-03T09:00:00.000Z")];
  assert.deepEqual(threadsToFold(comments, RUN_START), ["old-1"]);
});

test("skips threads that are already folded", () => {
  const comments = [
    c("done", "2026-11-02T08:00:00.000Z", { resolved: true }),
    c("old", "2026-11-03T08:00:00.000Z"),
    c("result", "2026-11-04T10:05:00.000Z")
  ];
  assert.deepEqual(threadsToFold(comments, RUN_START), ["old"]);
});

test("keeps an old thread open when someone replied in it during the run", () => {
  const comments = [
    c("question", "2026-11-03T08:00:00.000Z"),
    c("old", "2026-11-03T09:00:00.000Z"),
    c("reply", "2026-11-04T10:02:00.000Z", { parentId: "question" }),
    c("result", "2026-11-04T10:05:00.000Z")
  ];
  assert.deepEqual(threadsToFold(comments, RUN_START), ["old"]);
});

test("keeps the thread holding the newest comment open", () => {
  const comments = [
    c("old", "2026-11-03T07:00:00.000Z"),
    c("question", "2026-11-03T08:00:00.000Z"),
    c("reply", "2026-11-03T09:00:00.000Z", { parentId: "question" })
  ];
  assert.deepEqual(threadsToFold(comments, RUN_START), ["old"]);
});

test("folds by thread: an old reply is folded with its root, not on its own", () => {
  const comments = [
    c("question", "2026-11-03T08:00:00.000Z"),
    c("reply", "2026-11-03T08:30:00.000Z", { parentId: "question" }),
    c("result", "2026-11-04T10:05:00.000Z")
  ];
  assert.deepEqual(threadsToFold(comments, RUN_START), ["question"]);
});

test("nothing to fold on a ticket with no comments", () => {
  assert.deepEqual(threadsToFold([], RUN_START), []);
});
