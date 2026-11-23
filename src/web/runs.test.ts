import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuns, changeRequestUrl, type LogRow } from "./runs.ts";

const row = (identifier: string, event: string, at: string, detail = "", extra: Partial<LogRow> = {}): LogRow => ({
  identifier,
  event,
  detail,
  createdAt: `2026-11-20T${at}:00.000Z`,
  ...extra
});

test("a program run: fired → dispatch → agent-done → program-run-done", () => {
  const runs = buildRuns([
    row("OPS-1", "program-fired", "10:00", "source: trigger — deploy finished (from: Todo)", { data: { source: "trigger" } }),
    row("OPS-1", "dispatch", "10:00", "program → (no repo) [none] ⎇ (program run)", { data: { title: "Nightly report" } }),
    row("OPS-1", "agent-start", "10:01"),
    row("OPS-1", "agent-done", "10:05", "in 240.0s", { tokensIn: 1000, tokensOut: 200 }),
    row("OPS-1", "program-run-done", "10:06", "→ Todo (ok)", { data: { last_result: "ok" } })
  ]);
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.equal(run!.kind, "program");
  assert.equal(run!.title, "Nightly report");
  assert.equal(run!.source, "trigger");
  assert.equal(run!.reason, "deploy finished");
  assert.equal(run!.outcome, "ok");
  assert.equal(run!.detail, "→ Todo (ok)");
  assert.deepEqual(run!.tokens, { in: 1000, out: 200 });
  assert.equal(run!.durationMs, 6 * 60_000);
});

test("a coding run keeps the CR link and reads a timeout", () => {
  const runs = buildRuns([
    row("APP-7", "dispatch", "09:00", "processing → group/app [gitlab] ⎇ gene/app-7-fix", { data: { title: "Fix it" } }),
    row("APP-7", "agent-start", "09:00"),
    row("APP-7", "cr-linked", "09:20", "linked https://gitlab.com/group/app/-/merge_requests/12 to APP-7"),
    row("APP-7", "agent-error", "09:30", "exited 1 (timed out at 1800s)")
  ]);
  const [run] = runs;
  assert.equal(run!.kind, "ticket");
  assert.equal(run!.intent, "processing");
  assert.equal(run!.outcome, "timeout");
  assert.deepEqual(run!.links, ["https://gitlab.com/group/app/-/merge_requests/12"]);
  assert.equal(run!.notes[0]!.event, "cr-linked");
});

test("open runs: live → running, lost → interrupted, never spawned → dispatched", () => {
  const rows = [
    row("A-1", "dispatch", "08:00", "processing → r [github] ⎇ b"),
    row("A-1", "agent-start", "08:00"),
    row("A-1", "dispatch", "09:00", "resume → r [github] ⎇ b"),
    row("A-1", "agent-start", "09:00"),
    row("B-2", "dispatch", "09:30", "processing → r [github] ⎇ b")
  ];
  const runs = buildRuns(rows, new Set(["A-1"]));
  assert.deepEqual(
    runs.map(r => [r.identifier, r.intent, r.outcome]),
    [
      ["B-2", "processing", "dispatched"],
      ["A-1", "resume", "running"],
      ["A-1", "processing", "interrupted"]
    ]
  );
});

test("rows before the window's first dispatch are ignored", () => {
  const runs = buildRuns([row("A-1", "agent-done", "07:00", "in 1s"), row("A-1", "review", "07:30", "ci failed")]);
  assert.equal(runs.length, 0);
});

test("changeRequestUrl pulls the URL out of a cr-linked detail", () => {
  assert.equal(changeRequestUrl("linked https://github.com/o/r/pull/3 to X-1"), "https://github.com/o/r/pull/3");
  assert.equal(changeRequestUrl("nothing here"), undefined);
});
