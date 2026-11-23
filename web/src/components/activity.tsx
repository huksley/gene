import { useMemo, useState } from "react";
import { ChevronRight, Repeat, Code2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dot, OutcomeBadge, outcomeTone } from "@/components/status";
import { CrLink, TicketLink } from "@/components/links";
import { LatestComment } from "@/components/comment";
import { clock, dateTime, dayKey, dayLabel, duration, tokens } from "@/lib/format";
import type { CommentView, RunView } from "@/lib/types";
import { cn } from "@/lib/utils";

type Filter = "all" | "program" | "ticket";

const RunRow = ({ run, comment }: { run: RunView; comment?: CommentView }) => {
  const [open, setOpen] = useState(false);
  const crs = run.links.filter(l => /merge_requests|\/pull\//.test(l));
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className="group grid cursor-pointer grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 hover:bg-muted/50 active:bg-muted/50 sm:grid-cols-[3rem_6.5rem_1fr_auto]"
        >
          <span className="hidden font-mono text-xs tabular-nums text-muted-foreground sm:inline" title={dateTime(run.startedAt)}>
            {clock(run.startedAt)}
          </span>
          <OutcomeBadge outcome={run.outcome} className="hidden sm:inline-flex" />
          {/* Phone: title on its own line, the facts underneath. */}
          <div className="min-w-0 sm:hidden">
            <div className="flex items-start gap-2">
              <Dot tone={outcomeTone(run.outcome)} pulse={run.outcome === "running"} className="mt-1.5" />
              <span className="line-clamp-2 text-sm leading-snug">{run.title ?? "Untitled"}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-xs text-muted-foreground tabular-nums">
              <span>{clock(run.startedAt)}</span>
              <TicketLink identifier={run.identifier} url={run.url} />
              <span>{run.kind === "program" ? (run.source ?? "program") : run.intent}</span>
              <span>{duration(run.durationMs)}</span>
              {crs.slice(0, 1).map(url => (
                <CrLink key={url} url={url} />
              ))}
            </div>
          </div>
          <div className="hidden min-w-0 items-center gap-2 sm:flex">
            {run.kind === "program" ? (
              <Repeat className="size-3.5 shrink-0 text-muted-foreground" aria-label="program" />
            ) : (
              <Code2 className="size-3.5 shrink-0 text-muted-foreground" aria-label="ticket" />
            )}
            <TicketLink identifier={run.identifier} url={run.url} className="shrink-0" />
            <span className="truncate text-sm">{run.title ?? "Untitled"}</span>
            <Badge variant="secondary" className="hidden font-normal md:inline-flex">
              {run.kind === "program" ? (run.source ?? "program") : run.intent}
            </Badge>
          </div>
          <div className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
            <span className="hidden sm:contents">
              {crs.slice(0, 1).map(url => (
                <CrLink key={url} url={url} />
              ))}
            </span>
            <span className="hidden w-16 text-right lg:inline">{tokens((run.tokens?.in ?? 0) + (run.tokens?.out ?? 0))}</span>
            <span className="hidden w-14 text-right sm:inline">{duration(run.durationMs)}</span>
            <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t bg-muted/20 px-4 py-3 text-sm sm:pl-[4.75rem]">
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs sm:grid-cols-[7rem_1fr] sm:gap-x-4">
            <dt className="text-muted-foreground sm:hidden">Outcome</dt>
            <dd className="sm:hidden"><OutcomeBadge outcome={run.outcome} /></dd>
            <dt className="text-muted-foreground">Started</dt>
            <dd>{dateTime(run.startedAt)}</dd>
            {run.endedAt && (
              <>
                <dt className="text-muted-foreground">Ended</dt>
                <dd>{dateTime(run.endedAt)} · {duration(run.durationMs)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{run.kind === "program" ? "Fired by" : "Intent"}</dt>
            <dd>
              {run.kind === "program" ? (run.source ?? "—") : run.intent}
              {run.reason && <span className="text-muted-foreground"> — {run.reason}</span>}
            </dd>
            {run.detail && (
              <>
                <dt className="text-muted-foreground">Result</dt>
                <dd className="font-mono break-words">{run.detail}</dd>
              </>
            )}
            {run.tokens && (
              <>
                <dt className="text-muted-foreground">Tokens</dt>
                <dd className="tabular-nums">{tokens(run.tokens.in)} in · {tokens(run.tokens.out)} out</dd>
              </>
            )}
            {run.notes.map((n, i) => (
              <div key={i} className="contents">
                <dt className="text-muted-foreground">{n.event}</dt>
                <dd className="break-words">{n.detail}</dd>
              </div>
            ))}
            {run.links.length > 0 && (
              <>
                <dt className="text-muted-foreground">Links</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {run.links.map(url => (
                    <CrLink key={url} url={url} />
                  ))}
                </dd>
              </>
            )}
          </dl>
          {comment && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Latest comment on the ticket</p>
              <LatestComment comment={comment} />
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

export const Activity = ({ runs, comments }: { runs: RunView[]; comments: Map<string, CommentView | undefined> }) => {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(() => runs.filter(r => filter === "all" || r.kind === filter), [runs, filter]);

  // The latest run per ticket carries the ticket's latest comment (its resolution).
  const latestRun = useMemo(() => {
    const seen = new Set<string>();
    const out = new Set<RunView>();
    for (const r of runs) if (!seen.has(r.identifier)) (seen.add(r.identifier), out.add(r));
    return out;
  }, [runs]);

  const days = useMemo(() => {
    const groups: { key: string; label: string; runs: RunView[] }[] = [];
    for (const run of shown) {
      const key = dayKey(run.startedAt);
      const last = groups.at(-1);
      if (last?.key === key) last.runs.push(run);
      else groups.push({ key, label: dayLabel(run.startedAt), runs: [run] });
    }
    return groups;
  }, [shown]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {(["all", "program", "ticket"] as const).map(f => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              filter === f ? "border-foreground/20 bg-foreground text-background" : "text-muted-foreground hover:bg-accent"
            )}
          >
            {f === "all" ? "All runs" : f === "program" ? "Programs" : "Tickets"}
          </button>
        ))}
      </div>
      {days.length === 0 && (
        <Card className="items-center py-12 text-sm text-muted-foreground">No runs in this window.</Card>
      )}
      {days.map(day => (
        <section key={day.key}>
          <h3 className="mb-2 flex items-baseline gap-2 px-1 text-sm font-medium">
            {day.label}
            <span className="text-xs font-normal text-muted-foreground">{day.runs.length} run{day.runs.length === 1 ? "" : "s"}</span>
          </h3>
          <Card className="gap-0 divide-y overflow-hidden py-0">
            {day.runs.map(run => (
              <RunRow
                key={`${run.identifier}-${run.startedAt}`}
                run={run}
                comment={latestRun.has(run) ? comments.get(run.identifier) : undefined}
              />
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
};
