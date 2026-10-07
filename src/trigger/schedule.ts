/**
 * Pure scheduling rules for trigger checks: when a check is due, which gate skips it
 * (busy / cooldown), and how long until the next evaluation. No I/O — the scanner
 * (index.ts) feeds it the facts and acts on the verdict.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type TriggerGate = { kind: "not-due" } | { kind: "skip"; reason: "busy" | "cooldown" } | { kind: "run" };

export const decideTrigger = (i: {
  now: Date;
  nextCheckAt?: Date;
  /** Program at rest: not active/blocked, no run in flight, no fire queued. */
  resting: boolean;
  /** Last fire of any source (manual `g` included). */
  lastFiredAt?: Date;
  cooldownMs: number;
}): TriggerGate => {
  if (i.nextCheckAt && i.now.getTime() < i.nextCheckAt.getTime()) return { kind: "not-due" };
  if (!i.resting) return { kind: "skip", reason: "busy" };
  if (i.lastFiredAt && i.now.getTime() - i.lastFiredAt.getTime() < i.cooldownMs) {
    return { kind: "skip", reason: "cooldown" };
  }
  return { kind: "run" };
};

export const effectiveIntervalMs = (i: {
  intervalSec?: number;
  usedIo: boolean;
  errorStreak: number;
  pollMs: number;
  ioFloorMs: number;
}): number => {
  let base = Math.min(Math.max((i.intervalSec ?? 0) * 1000, i.pollMs), DAY_MS);
  if (i.usedIo) base = Math.max(base, i.ioFloorMs);
  if (i.errorStreak > 0) base = Math.max(base, Math.min(base * 2 ** i.errorStreak, HOUR_MS));
  return base;
};

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** "90s" / "15m" / "1h" / "1d" → seconds; undefined for anything else (or zero). */
export const parseDurationSec = (text: string): number | undefined => {
  const m = /^(\d+)\s*([smhd])$/.exec(text.trim());
  if (!m) return undefined;
  const value = Number(m[1]) * UNITS[m[2]!]!;
  return value > 0 ? value : undefined;
};
