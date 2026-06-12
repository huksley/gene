/**
 * A setTimeout that only counts active (foreground) time. While the host is
 * suspended — laptop asleep, the process SIGSTOPped — the whole Node process is
 * frozen and no time accrues, so the callback fires after `ms` of *running*
 * time rather than wall-clock time.
 *
 * Why not a plain setTimeout: Node's timers run off a clock that, on macOS,
 * keeps advancing during sleep (and the behavior differs on Linux), so a long
 * suspend burns the budget and the timer fires immediately on wake. This helper
 * sidesteps clock-source semantics entirely.
 *
 * How: a low-frequency self-correcting interval. Each tick adds the elapsed
 * delta to a budget, but any gap larger than `maxGapMs` — too long to be
 * anything but a freeze — is clamped, discarding the suspend. libuv fires a
 * repeating timer only once on resume (it never replays missed iterations), so
 * a multi-hour sleep contributes a single clamped tick. Ordinary event-loop lag
 * stays under the clamp and counts in full, so the timer never fires early.
 */

import { performance } from "node:perf_hooks";

export type ActiveTimeout = {
  /** Stop the timer. Idempotent. */
  cancel: () => void;
};

export type ActiveTimeoutOptions = {
  /** How often to accrue time, in ms (default 1000). Also the deadline resolution. */
  tickMs?: number;
  /** Inter-tick gaps above this are treated as a freeze and clamped (default 5000). */
  maxGapMs?: number;
};

/**
 * Fire `callback` after `ms` of active (non-suspended) time. Returns a handle
 * whose `cancel()` clears the timer — call it once the work finishes, exactly
 * as you would `clearTimeout`.
 */
export const setActiveTimeout = (
  callback: () => void,
  ms: number,
  opts: ActiveTimeoutOptions = {}
): ActiveTimeout => {
  const tickMs = opts.tickMs ?? 1000;
  const maxGapMs = opts.maxGapMs ?? 5000;
  let activeMs = 0;
  let last = performance.now(); // monotonic; we clamp, so the source is moot
  const timer = setInterval(() => {
    const now = performance.now();
    activeMs += Math.min(now - last, maxGapMs);
    last = now;
    if (activeMs >= ms) {
      clearInterval(timer);
      callback();
    }
  }, tickMs);
  return { cancel: () => clearInterval(timer) };
};
