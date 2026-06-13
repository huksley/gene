import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenAccumulator, type RawUsage } from "./tokens.ts";

// Usage helper: (non-cached input, cache_creation, cache_read, output).
const U = (input: number, cc: number, cr: number, out: number): RawUsage => ({
  input_tokens: input,
  cache_creation_input_tokens: cc,
  cache_read_input_tokens: cr,
  output_tokens: out
});

// Stream-event builders mirroring `claude -p --include-partial-messages` output.
const start = (u: RawUsage) => ({ type: "stream_event", event: { type: "message_start", message: { usage: u } } });
const delta = (u: RawUsage) => ({ type: "stream_event", event: { type: "message_delta", usage: u } });
const result = (u: RawUsage) => ({ type: "result", subtype: "success", usage: u });
const assistant = (u: RawUsage) => ({ type: "assistant", message: { usage: u } });

// A real 4-turn run captured from claude -p (deltas 102/98/99/84 → result out 383).
// Each turn: message_start (out placeholder 1) then message_delta (turn's true totals).
const TURNS: { startU: RawUsage; deltaU: RawUsage }[] = [
  { startU: U(11378, 2047, 14399, 1), deltaU: U(11378, 2047, 14399, 102) },
  { startU: U(2, 11486, 16446, 1), deltaU: U(2, 11486, 16446, 98) },
  { startU: U(2, 106, 27932, 1), deltaU: U(2, 106, 27932, 99) },
  { startU: U(2, 107, 28038, 1), deltaU: U(2, 107, 28038, 84) }
];
const RESULT_U = U(11384, 13746, 86815, 383);
const TOTAL_IN = 111_945; // 27824 + 27934 + 28040 + 28147
const TOTAL_OUT = 383; // 102 + 98 + 99 + 84

const feedTurns = (acc: TokenAccumulator, n: number): void => {
  for (let i = 0; i < n; i += 1) {
    acc.observe(start(TURNS[i]!.startU));
    acc.observe(delta(TURNS[i]!.deltaU));
  }
};

test("clean run: final total matches the authoritative result event", () => {
  const acc = new TokenAccumulator();
  feedTurns(acc, 4);
  const final = acc.observe(result(RESULT_U));
  assert.deepEqual(final, { in: TOTAL_IN, out: TOTAL_OUT, total: TOTAL_IN + TOTAL_OUT });
});

test("crashed run (no result event): accumulation still equals the true totals", () => {
  const acc = new TokenAccumulator();
  feedTurns(acc, 4);
  assert.deepEqual(acc.total(), { in: TOTAL_IN, out: TOTAL_OUT, total: TOTAL_IN + TOTAL_OUT });
});

test("output is tracked live across turns, not stuck at the message_start placeholder", () => {
  const acc = new TokenAccumulator();
  feedTurns(acc, 2);
  // After two complete turns: out = 102 + 98, in = 27824 + 27934.
  assert.deepEqual(acc.total(), { in: 55_758, out: 200, total: 55_958 });
});

test("mid-turn: out reflects the latest delta, not 1", () => {
  const acc = new TokenAccumulator();
  acc.observe(start(TURNS[0]!.startU)); // out placeholder 1
  const afterStart = acc.total();
  assert.equal(afterStart.out, 1);
  const afterDelta = acc.observe(delta(TURNS[0]!.deltaU));
  assert.equal(afterDelta.out, 102);
});

test("complete assistant events (message_start snapshots) do not corrupt the total", () => {
  const acc = new TokenAccumulator();
  acc.observe(assistant(U(11378, 2047, 14399, 1))); // ignored
  feedTurns(acc, 1);
  acc.observe(assistant(U(2, 0, 0, 1))); // ignored
  const final = acc.observe(result(U(11378, 2047, 14399, 102)));
  assert.deepEqual(final, { in: 27_824, out: 102, total: 27_926 });
});

test("no usage at all → zeroed totals", () => {
  const acc = new TokenAccumulator();
  acc.observe({ type: "system" });
  assert.deepEqual(acc.total(), { in: 0, out: 0, total: 0 });
});
