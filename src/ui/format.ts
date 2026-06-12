/**
 * Small formatting helpers for the dashboard. Pure string/number math with no
 * dependencies, so they're trivially testable and reusable across the view.
 */

/** Round `n` to `digits` decimals and drop trailing zeros: 1.40 → "1.4", 17.0 → "17". */
const trim = (n: number, digits: number): string => Number(n.toFixed(digits)).toString();

/**
 * Compact human duration: "45s", "1m 19s", "2h 03m". Negative inputs clamp to 0.
 * Used for uptime, run age, and run duration.
 */
export const humanDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  if (m > 0) {
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  return `${s}s`;
};

/** Whole seconds remaining until `epochMs`, never negative, rounded up. */
export const secondsUntil = (epochMs: number, now: number): number =>
  Math.max(0, Math.ceil((epochMs - now) / 1000));

/** Compact token count: 512, 1.4k, 17k, 1.46M, 2.3B. */
export const compactTokens = (n: number): string => {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${trim(n / 1000, 1)}k`;
  }
  if (n < 1_000_000_000) {
    return `${trim(n / 1_000_000, 2)}M`;
  }
  return `${trim(n / 1_000_000_000, 2)}B`;
};

/** Truncate to `max` columns with a trailing ellipsis (mirrors invoke.ts's truncate). */
export const truncate = (s: string, max: number): string => {
  if (max <= 0) {
    return "";
  }
  if (s.length <= max) {
    return s;
  }
  if (max === 1) {
    return "…";
  }
  return `${s.slice(0, max - 1)}…`;
};

/** Truncate then left-pad to exactly `width` columns, for fixed-width table cells. */
export const fit = (s: string, width: number): string => truncate(s, width).padEnd(width);

/** A fixed-width progress bar string from a 0..1 ratio (clamped). */
export const progressBar = (
  ratio: number,
  width: number,
  filledCh = "▓",
  emptyCh = "░"
): string => {
  const clamped = Math.min(1, Math.max(0, ratio));
  const filled = Math.round(clamped * width);
  return filledCh.repeat(filled) + emptyCh.repeat(Math.max(0, width - filled));
};

/**
 * Strip SGR color escapes from a string. The logger's {@link formatRecord}
 * returns chalk-colored (ANSI) text; OpenTUI's `Text` content is plain/StyledText
 * and would render raw escapes literally, so we strip them and re-color by level.
 */
// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
