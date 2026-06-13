/**
 * Per-run token accounting for the `claude -p` stream.
 *
 * The naive "read usage off every event" approach is wrong for output: the
 * `assistant` / `message_start` events only carry a placeholder `output_tokens`
 * (≈1); the real per-turn output lands in the `message_delta` partial events
 * (`event.event.usage`), and the authoritative session total only arrives in the
 * terminal `result` event. So a run that never emits a `result` (timeout kill,
 * silent crash) would otherwise report ~1 output token.
 *
 * {@link TokenAccumulator} folds the per-turn `message_delta` usage into a running
 * absolute total — correct live, correct across turns, and crash-resilient (the
 * accumulation equals the result event for a clean run) — and trusts the `result`
 * event outright when it arrives. Kept dependency-free so it is unit-testable in
 * isolation from the tracker/Postgres import graph.
 */

import type { TokenUsage } from "./monitor.ts";

/** Raw usage block as emitted on stream events (input + the two cache buckets + output). */
export type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

/** The subset of a parsed stream-json event the accumulator reads. */
export type TokenStreamEvent = {
  type?: string;
  /** Top-level usage — present on the terminal `result` event. */
  usage?: RawUsage;
  /** Complete-message usage (a `message_start` snapshot; deliberately ignored). */
  message?: { usage?: RawUsage };
  /** The `--include-partial-messages` wrapper: message_start / message_delta. */
  event?: { type?: string; usage?: RawUsage; message?: { usage?: RawUsage } };
};

/** Total input = non-cached input + both cache buckets (the disjoint pieces of input). */
const foldInput = (u: RawUsage | undefined): number =>
  (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);

export class TokenAccumulator {
  /** Input/output banked from turns that have ended (every turn before the current one). */
  private committedIn = 0;
  private committedOut = 0;
  /** Running input/output for the turn in progress (overwritten as its deltas arrive). */
  private currentIn = 0;
  private currentOut = 0;
  /** Once the authoritative result lands we stop accumulating and report it verbatim. */
  private finalized = false;

  /** Feed one parsed stream event; returns the current absolute total. */
  observe(event: TokenStreamEvent): TokenUsage {
    // The result event is the authoritative session total — trust it and freeze.
    if (event.type === "result" && event.usage) {
      this.committedIn = foldInput(event.usage);
      this.committedOut = event.usage.output_tokens ?? 0;
      this.currentIn = 0;
      this.currentOut = 0;
      this.finalized = true;
      return this.total();
    }
    if (this.finalized) {
      return this.total();
    }

    const inner = event.type === "stream_event" ? event.event : undefined;
    if (inner?.type === "message_start") {
      // A new turn begins: bank the turn that just finished, then seed from this
      // turn's start snapshot (its output is the ≈1 placeholder until deltas land).
      this.committedIn += this.currentIn;
      this.committedOut += this.currentOut;
      this.currentIn = foldInput(inner.message?.usage);
      this.currentOut = inner.message?.usage?.output_tokens ?? 0;
    } else if (inner?.type === "message_delta" && inner.usage) {
      // message_delta carries the running totals for the CURRENT turn — overwrite.
      this.currentIn = foldInput(inner.usage);
      this.currentOut = inner.usage.output_tokens ?? 0;
    }
    return this.total();
  }

  /** The current absolute total: banked turns plus the in-progress one. */
  total(): TokenUsage {
    const inSum = this.committedIn + this.currentIn;
    const outSum = this.committedOut + this.currentOut;
    return { in: inSum, out: outSum, total: inSum + outSum };
  }
}
