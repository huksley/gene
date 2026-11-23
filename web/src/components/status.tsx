import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RunOutcome } from "@/lib/types";

type Tone = "ok" | "warn" | "bad" | "run" | "idle" | "review";

const OUTCOME_TONE: Record<RunOutcome, Tone> = {
  running: "run",
  dispatched: "idle",
  ok: "ok",
  done: "ok",
  incomplete: "warn",
  blocked: "warn",
  stalled: "warn",
  timeout: "warn",
  cancelled: "idle",
  error: "bad",
  interrupted: "bad"
};

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  run: "text-run",
  idle: "text-idle",
  review: "text-violet-500 dark:text-violet-400"
};

const TONE_BG: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  run: "bg-run",
  idle: "bg-idle",
  review: "bg-violet-500 dark:bg-violet-400"
};

export const outcomeTone = (o: RunOutcome): Tone => OUTCOME_TONE[o] ?? "idle";
export const toneBg = (t: Tone): string => TONE_BG[t];

export const Dot = ({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) => (
  <span className={cn("relative inline-flex size-2 shrink-0", className)}>
    {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", TONE_BG[tone])} />}
    <span className={cn("relative inline-flex size-2 rounded-full", TONE_BG[tone])} />
  </span>
);

export const OutcomeBadge = ({ outcome, className }: { outcome: RunOutcome; className?: string }) => {
  const tone = outcomeTone(outcome);
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", className)}>
      <Dot tone={tone} pulse={outcome === "running"} />
      <span className={TONE_TEXT[tone]}>{outcome}</span>
    </Badge>
  );
};

/** Tracker states vary by team; tone them by the usual names. */
const stateTone = (state: string): Tone => {
  const s = state.toLowerCase();
  if (/progress|doing|active|running/.test(s)) return "run";
  if (/block/.test(s)) return "warn";
  if (/review/.test(s)) return "review";
  if (/done|complete|merged|closed/.test(s)) return "ok";
  if (/cancel/.test(s)) return "bad";
  return "idle";
};

export const StateBadge = ({ state }: { state: string }) => (
  <Badge variant="secondary" className="gap-1.5 font-normal">
    <Dot tone={stateTone(state)} />
    {state}
  </Badge>
);
