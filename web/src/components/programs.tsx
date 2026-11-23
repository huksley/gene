import { useState } from "react";
import { AlertTriangle, ChevronRight, Clock, Zap } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { Dot, OutcomeBadge, StateBadge, outcomeTone, toneBg } from "@/components/status";
import { TicketLink } from "@/components/links";
import { LatestComment } from "@/components/comment";
import { dateTime, duration, relative } from "@/lib/format";
import type { ProgramView, RunOutcome, RunView } from "@/lib/types";
import { cn } from "@/lib/utils";

const HISTORY = 30;

/** The program's recent runs as bars filling the width, oldest left; height ∝ duration. */
const RunStrip = ({ runs, className }: { runs: RunView[]; className?: string }) => {
  const recent = runs.slice(0, HISTORY).reverse();
  const pad = HISTORY - recent.length;
  return (
    <div className={cn("grid h-6 items-end gap-[2px]", className)} style={{ gridTemplateColumns: `repeat(${HISTORY}, minmax(0, 1fr))` }}>
      {Array.from({ length: pad }, (_, i) => (
        <span key={`pad-${i}`} className="h-1.5 rounded-[2px] bg-muted" />
      ))}
      {recent.map(run => (
        <Tooltip key={run.startedAt}>
          <TooltipTrigger asChild>
            <span
              className={cn("rounded-[2px] opacity-85 hover:opacity-100", toneBg(outcomeTone(run.outcome)), run.outcome === "running" && "animate-pulse")}
              style={{ height: `${Math.max(30, Math.min(100, ((run.durationMs ?? 0) / 600_000) * 100))}%` }}
            />
          </TooltipTrigger>
          <TooltipContent>
            {dateTime(run.startedAt)} · {run.outcome} · {duration(run.durationMs)}
            {run.source ? ` · ${run.source}` : ""}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
};

const summary = (program: ProgramView) => {
  const last = program.runs[0];
  return {
    last,
    outcome: (last?.outcome ?? program.lastResult) as RunOutcome | undefined,
    ok: program.runs.filter(r => r.outcome === "ok" || r.outcome === "done").length
  };
};

const TriggerLine = ({ t }: { t: NonNullable<ProgramView["trigger"]> }) => (
  <div className="space-y-1 text-xs text-muted-foreground">
    <div className="flex min-w-0 items-start gap-1.5">
      {t.status === "ok" ? <Zap className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />}
      <span className="text-foreground">{t.summary ?? t.error ?? `trigger ${t.status}`}</span>
    </div>
    {t.status === "ok" && (
      <div className="flex items-center gap-1.5">
        <Clock className="size-3.5 shrink-0" />
        {t.armed === false ? "not armed (outside the trigger state)" : `next check ${relative(t.nextCheckAt)}`}
        {t.lastOutcome && ` · last: ${t.lastOutcome}`}
      </div>
    )}
  </div>
);

const Facts = ({ program }: { program: ProgramView }) => {
  const { last, ok } = summary(program);
  return (
    <div className="grid grid-cols-3 gap-3 text-xs">
      <div>
        <p className="text-muted-foreground">Last run</p>
        <p className="font-medium" title={last ? dateTime(last.startedAt) : program.lastFiredAt}>
          {relative(last?.startedAt ?? program.lastFiredAt)}
        </p>
      </div>
      <div>
        <p className="text-muted-foreground">Took</p>
        <p className="font-medium tabular-nums">{duration(last?.durationMs)}</p>
      </div>
      <div>
        <p className="text-muted-foreground">Runs (ok)</p>
        <p className="font-medium tabular-nums">
          {program.runs.length} <span className="text-muted-foreground">({ok})</span>
        </p>
      </div>
    </div>
  );
};

const FiredBy = ({ run }: { run?: RunView }) =>
  run?.reason || run?.source ? (
    <p className="text-xs text-muted-foreground">
      Fired by <span className="text-foreground">{run.source ?? "?"}</span>
      {run.reason && <> — {run.reason}</>}
    </p>
  ) : null;

/** Desktop: one card per program. */
const ProgramCard = ({ program }: { program: ProgramView }) => {
  const { last, outcome } = summary(program);
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="leading-snug">{program.title}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <TicketLink identifier={program.identifier} url={program.url} />
          <StateBadge state={program.state} />
        </CardDescription>
        <CardAction>{outcome && <OutcomeBadge outcome={outcome} />}</CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <Facts program={program} />
        <RunStrip runs={program.runs} />
        <FiredBy run={last} />
        <LatestComment comment={program.latestComment} />
      </CardContent>
      {program.trigger && (
        <>
          <Separator />
          <CardFooter>
            <TriggerLine t={program.trigger} />
          </CardFooter>
        </>
      )}
    </Card>
  );
};

/** The last few runs spelled out — on a phone the strip's tooltips can't be hovered. */
const RecentRuns = ({ runs }: { runs: RunView[] }) => (
  <div>
    <p className="mb-1 text-xs font-medium text-muted-foreground">Recent runs</p>
    <ul className="divide-y rounded-lg border text-xs">
      {runs.slice(0, 5).map(run => (
        <li key={run.startedAt} className="flex items-center gap-2 px-2.5 py-1.5 tabular-nums">
          <Dot tone={outcomeTone(run.outcome)} pulse={run.outcome === "running"} />
          <span className="w-20 shrink-0">{relative(run.startedAt)}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {run.outcome}
            {run.source && ` · ${run.source}`}
          </span>
          <span className="shrink-0 text-muted-foreground">{duration(run.durationMs)}</span>
        </li>
      ))}
    </ul>
  </div>
);

/** Phone: a compact row per program; tap to expand the resolution and trigger. */
const ProgramRow = ({ program }: { program: ProgramView }) => {
  const [open, setOpen] = useState(false);
  const { last, outcome } = summary(program);
  const tone = outcome ? outcomeTone(outcome) : "idle";
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} className="block w-full space-y-2 px-4 py-3 text-left active:bg-muted/50" aria-expanded={open}>
        <div className="flex items-start gap-2.5">
          <Dot tone={tone} pulse={outcome === "running"} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium leading-snug">{program.title}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span className="font-mono">{program.identifier}</span>
              <span>·</span>
              <span>{program.state}</span>
              <span>·</span>
              <span>{outcome ?? "never ran"}</span>
              {last && (
                <>
                  <span>·</span>
                  <span>{relative(last.startedAt)}</span>
                </>
              )}
            </p>
          </div>
          <ChevronRight className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        </div>
        <RunStrip runs={program.runs} className="h-5 pl-[18px]" />
      </button>
      {open && (
        <div className="space-y-3 px-4 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <TicketLink identifier={program.identifier} url={program.url} />
            <StateBadge state={program.state} />
            {outcome && <OutcomeBadge outcome={outcome} />}
          </div>
          <Facts program={program} />
          <FiredBy run={last} />
          <LatestComment comment={program.latestComment} />
          {program.runs.length > 0 && <RecentRuns runs={program.runs} />}
          {program.trigger && <TriggerLine t={program.trigger} />}
        </div>
      )}
    </div>
  );
};

export const Programs = ({ programs }: { programs: ProgramView[] }) => {
  if (programs.length === 0) {
    return <Card className="items-center py-12 text-sm text-muted-foreground">No programs.</Card>;
  }
  const sorted = [...programs].sort(
    (a, b) => Date.parse(b.runs[0]?.startedAt ?? b.lastFiredAt ?? "0") - Date.parse(a.runs[0]?.startedAt ?? a.lastFiredAt ?? "0")
  );
  return (
    <>
      <Card className="gap-0 divide-y overflow-hidden py-0 md:hidden">
        {sorted.map(p => (
          <ProgramRow key={p.identifier} program={p} />
        ))}
      </Card>
      <div className="hidden gap-4 md:grid lg:grid-cols-2">
        {sorted.map(p => (
          <ProgramCard key={p.identifier} program={p} />
        ))}
      </div>
    </>
  );
};
