/** One-line, plain-text trigger status for the program detail view. */
import { humanDuration } from "./format.ts";
import type { TriggerView } from "../trigger/index.ts";

const outcomeText = (v: TriggerView): string => {
  const outcome = v.lastOutcome;
  if (outcome === undefined) return "not checked yet";
  if (outcome === "fire") return `fired${v.lastReason ? ` — ${v.lastReason}` : ""}`;
  if (outcome === "no-fire") return "no fire";
  if (outcome === "error") return `error — ${v.lastReason ?? "unknown"}`;
  if (outcome.startsWith("skipped:")) return `skipped (${outcome.slice("skipped:".length)})`;
  return outcome;
};

export const formatTriggerLine = (v: TriggerView, now: number): string => {
  if (v.status === "compiling") return "⟳ compiling trigger…";
  if (v.status !== "ok") return `⚠ trigger not compiled: ${v.error ?? v.status}`;
  const parts = [`ϟ ${v.summary ?? "trigger"}`];
  if (v.intervalSec) parts.push(`every ${humanDuration(v.intervalSec * 1000)}`);
  if (v.nextCheckAt !== undefined) parts.push(v.nextCheckAt <= now ? "due" : `next in ${humanDuration(v.nextCheckAt - now)}`);
  parts.push(`last: ${outcomeText(v)}`);
  return parts.join(" · ");
};
