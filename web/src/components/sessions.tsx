import { useMemo, useState } from "react";
import { Bot, Check, ChevronRight, Copy, GitBranch, Monitor, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dot, StateBadge } from "@/components/status";
import { PrChip } from "@/components/pr-chip";
import { Clamped } from "@/components/comment";
import { LinkedText, Markdown } from "@/components/markdown";
import { clock, dateTime, dayKey, dayLabel, duration, relative, tokens } from "@/lib/format";
import { usePolled } from "@/lib/use-polled";
import type { SessionKind, SessionPr, SessionsOverview, SessionTicket, SessionView } from "@/lib/types";
import { cn } from "@/lib/utils";

type View = "live" | "recent" | "tickets";
type KindFilter = "all" | SessionKind;

const KIND_ICON = { interactive: Monitor, gene: Bot, headless: Terminal } as const;
const KIND_LABEL = { interactive: "Interactive", gene: "Gene", headless: "Headless" } as const;

const Chips = <T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) => (
  <div className="flex flex-wrap items-center gap-1.5">
    {options.map(([v, label]) => (
      <button
        key={v}
        type="button"
        onClick={() => onChange(v)}
        className={cn(
          "rounded-full border px-3 py-1 text-xs transition-colors",
          value === v ? "border-foreground/20 bg-foreground text-background" : "text-muted-foreground hover:bg-accent"
        )}
      >
        {label}
      </button>
    ))}
  </div>
);

const TicketChip = ({ t }: { t: SessionTicket }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <a
        href={t.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        className={cn(
          "inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[11px] hover:underline",
          t.via === "prompt" ? "border border-dashed text-muted-foreground" : "bg-secondary text-secondary-foreground"
        )}
      >
        {t.identifier}
      </a>
    </TooltipTrigger>
    <TooltipContent>
      {t.title ? `${t.title}${t.state ? ` · ${t.state}` : ""} · ` : ""}
      {t.via === "worktree" ? "Gene worktree" : t.via === "branch" ? "from the branch" : t.via === "title" ? "in the session title" : "mentioned in a prompt"}
    </TooltipContent>
  </Tooltip>
);

const KindIcon = ({ kind }: { kind: SessionKind }) => {
  const Icon = KIND_ICON[kind];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={KIND_LABEL[kind]} />
      </TooltipTrigger>
      <TooltipContent>{KIND_LABEL[kind]}</TooltipContent>
    </Tooltip>
  );
};

const CopyResume = ({ s }: { s: SessionView }) => {
  const [copied, setCopied] = useState(false);
  const cmd = `${s.cwd ? `cd ${JSON.stringify(s.cwd)} && ` : ""}claude --resume ${s.sessionId}`;
  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(cmd).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="group inline-flex max-w-full items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
      title="Copy the command to resume this session"
    >
      <span className="truncate">claude --resume {s.sessionId}</span>
      {copied ? <Check className="size-3 shrink-0 text-ok" /> : <Copy className="size-3 shrink-0" />}
    </button>
  );
};

const Where = ({ s }: { s: SessionView }) => (
  <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
    <span className="truncate" title={s.cwd}>{s.project ?? "—"}</span>
    {s.branch && (
      <>
        <GitBranch className="size-3 shrink-0" />
        <span className="truncate font-mono" title={s.branch}>{s.branch}</span>
      </>
    )}
  </span>
);

const Links = ({ s, max = 3 }: { s: SessionView; max?: number }) => (
  <span className="flex flex-wrap items-center gap-1">
    {s.tickets.filter(t => t.via !== "prompt").concat(s.tickets.filter(t => t.via === "prompt")).slice(0, max).map(t => <TicketChip key={t.identifier} t={t} />)}
    {s.tickets.length > max && <span className="text-[11px] text-muted-foreground">+{s.tickets.length - max}</span>}
    {s.prs.slice(0, max).map(pr => <PrChip key={pr.url} pr={pr} />)}
    {s.prs.length > max && <span className="text-[11px] text-muted-foreground">+{s.prs.length - max}</span>}
  </span>
);

/** Prompts, the latest reply, tools, and where/how to resume. */
const SessionDetail = ({ s }: { s: SessionView }) => (
  <div className="space-y-3 text-sm">
    {s.recentPrompts.length > 0 && (
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">
          Recent prompts <span className="font-normal">({s.prompts} in all)</span>
        </p>
        <ol className="space-y-1.5">
          {s.recentPrompts.map((p, i) => (
            <li key={i} className="flex gap-3">
              <span className="w-10 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground" title={p.at && dateTime(p.at)}>
                {p.at ? clock(p.at) : ""}
              </span>
              <span className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words">
                <LinkedText text={p.text} />
              </span>
            </li>
          ))}
        </ol>
      </div>
    )}
    {s.lastReply && (
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Latest reply</p>
        <div className="min-w-0 rounded-lg border bg-muted/30 p-2.5">
          <Clamped watch={s.lastReply}>
            <Markdown source={s.lastReply} />
          </Clamped>
        </div>
      </div>
    )}
    <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs sm:grid-cols-[6.5rem_1fr] sm:gap-x-4">
      {s.tickets.length > 0 && (
        <>
          <dt className="text-muted-foreground">Tickets</dt>
          <dd className="flex flex-wrap gap-1">{s.tickets.map(t => <TicketChip key={t.identifier} t={t} />)}</dd>
        </>
      )}
      {s.prs.length > 0 && (
        <>
          <dt className="text-muted-foreground">PRs</dt>
          <dd className="flex flex-wrap gap-1">{s.prs.map(pr => <PrChip key={pr.url} pr={pr} />)}</dd>
        </>
      )}
      {s.tools.length > 0 && (
        <>
          <dt className="text-muted-foreground">Tools</dt>
          <dd className="text-muted-foreground">
            {s.tools.slice(0, 8).map(t => `${t.name} ×${t.count}`).join(" · ")}
            {s.lastTool && <span> — last {s.lastTool.name} {relative(s.lastTool.at)}</span>}
          </dd>
        </>
      )}
      <dt className="text-muted-foreground">Tokens</dt>
      <dd className="tabular-nums">
        {tokens(s.tokens.in)} in · {tokens(s.tokens.out)} out
        {s.costUsd !== undefined && ` · $${s.costUsd.toFixed(2)}`}
        {s.lines && ` · +${s.lines.added} −${s.lines.removed} lines`}
      </dd>
      {s.startedAt && (
        <>
          <dt className="text-muted-foreground">Span</dt>
          <dd>
            {dateTime(s.startedAt)}
            {s.lastAt && ` → ${clock(s.lastAt)} (${duration(Date.parse(s.lastAt) - Date.parse(s.startedAt))})`}
          </dd>
        </>
      )}
      <dt className="text-muted-foreground">Directory</dt>
      <dd className="break-all font-mono">{s.cwd ?? "—"}</dd>
      <dt className="text-muted-foreground">Client</dt>
      <dd>
        {s.entrypoint ?? "—"}
        {s.version && ` · v${s.version}`}
      </dd>
    </dl>
    <CopyResume s={s} />
  </div>
);

const LiveCard = ({ s, now }: { s: SessionView; now: number }) => {
  const [open, setOpen] = useState(false);
  const busy = s.live?.status === "busy";
  const last = s.recentPrompts.at(-1);
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-start gap-2 text-sm leading-snug">
          <Dot tone={busy ? "run" : "ok"} pulse={busy} className="mt-1.5" />
          <span className="line-clamp-2">{s.title ?? s.live?.name ?? "New session"}</span>
        </CardTitle>
        <CardDescription className="flex min-w-0 items-center gap-2 pl-4">
          <KindIcon kind={s.kind} />
          <Where s={s} />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <Links s={s} />
        {last && (
          <p className="line-clamp-2 break-words text-xs text-muted-foreground">
            › <LinkedText text={last.text} />
          </p>
        )}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
          <span>{busy ? "working" : "idle"}{s.lastAt && ` · ${relative(s.lastAt, now)}`}</span>
          <span>{s.prompts} prompts</span>
          <span>{tokens(s.tokens.in + s.tokens.out)} tok</span>
          <button type="button" onClick={() => setOpen(o => !o)} className="ml-auto inline-flex items-center gap-0.5 hover:text-foreground">
            Details <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
        </div>
        {open && (
          <div className="border-t pt-3">
            <SessionDetail s={s} />
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const SessionRow = ({ s }: { s: SessionView }) => {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div role="button" tabIndex={0} className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 hover:bg-muted/50 active:bg-muted/50 sm:grid-cols-[3rem_1fr_auto]">
          <span className="hidden font-mono text-xs tabular-nums text-muted-foreground sm:inline" title={s.lastAt && dateTime(s.lastAt)}>
            {s.lastAt ? clock(s.lastAt) : "—"}
          </span>
          <div className="min-w-0 space-y-1 sm:space-y-0.5">
            <div className="flex min-w-0 items-start gap-2 sm:items-center">
              <span className="mt-0.5 sm:mt-0">
                {s.live ? <Dot tone={s.live.status === "busy" ? "run" : "ok"} pulse={s.live.status === "busy"} /> : <KindIcon kind={s.kind} />}
              </span>
              <span className="line-clamp-2 text-sm leading-snug sm:truncate">{s.title ?? "Untitled session"}</span>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-5">
              <span className="font-mono text-xs tabular-nums text-muted-foreground sm:hidden">{s.lastAt ? clock(s.lastAt) : "—"}</span>
              <Where s={s} />
              <Links s={s} />
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
            <span className="hidden w-16 text-right sm:inline">{s.prompts} prompt{s.prompts === 1 ? "" : "s"}</span>
            <span className="hidden w-14 text-right md:inline">{tokens(s.tokens.in + s.tokens.out)}</span>
            <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="min-w-0 border-t bg-muted/20 px-4 py-3 sm:pl-[4.75rem]">
          <SessionDetail s={s} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const Recent = ({ sessions }: { sessions: SessionView[] }) => {
  const days = useMemo(() => {
    const groups: { key: string; label: string; items: SessionView[] }[] = [];
    const sorted = [...sessions].sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
    for (const s of sorted) {
      if (!s.lastAt) continue;
      const key = dayKey(s.lastAt);
      const last = groups.at(-1);
      if (last?.key === key) last.items.push(s);
      else groups.push({ key, label: dayLabel(s.lastAt), items: [s] });
    }
    return groups;
  }, [sessions]);
  if (days.length === 0) return <Empty>No sessions in this window.</Empty>;
  return (
    <div className="space-y-4">
      {days.map(day => (
        <section key={day.key}>
          <h3 className="mb-2 flex items-baseline gap-2 px-1 text-sm font-medium">
            {day.label}
            <span className="text-xs font-normal text-muted-foreground">{day.items.length} session{day.items.length === 1 ? "" : "s"}</span>
          </h3>
          <Card className="gap-0 divide-y overflow-hidden py-0">
            {day.items.map(s => <SessionRow key={s.sessionId} s={s} />)}
          </Card>
        </section>
      ))}
    </div>
  );
};

type TicketGroup = { ticket: SessionTicket; sessions: SessionView[]; prs: SessionPr[]; lastAt: string };

/** Every ticket the sessions touched, with its sessions and PRs; prompt mentions count last. */
const byTicket = (sessions: SessionView[], includeMentions: boolean): TicketGroup[] => {
  const groups = new Map<string, TicketGroup>();
  for (const s of sessions) {
    for (const t of s.tickets) {
      if (!includeMentions && t.via === "prompt") continue;
      let g = groups.get(t.identifier);
      if (!g) {
        g = { ticket: t, sessions: [], prs: [], lastAt: "" };
        groups.set(t.identifier, g);
      }
      if (t.title && !g.ticket.title) g.ticket = { ...g.ticket, title: t.title, state: t.state };
      g.sessions.push(s);
      if ((s.lastAt ?? "") > g.lastAt) g.lastAt = s.lastAt ?? "";
      // A session's PRs belong to its ticket only when the link is strong.
      if (t.via !== "prompt") for (const pr of s.prs) if (!g.prs.some(p => p.url === pr.url)) g.prs.push(pr);
    }
  }
  return [...groups.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
};

const Tickets = ({ sessions }: { sessions: SessionView[] }) => {
  const [mentions, setMentions] = useState(false);
  const groups = useMemo(() => byTicket(sessions, mentions), [sessions, mentions]);
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <input type="checkbox" checked={mentions} onChange={e => setMentions(e.target.checked)} className="accent-foreground" />
        Include tickets only mentioned in prompts
      </label>
      {groups.length === 0 && <Empty>No sessions linked to tickets in this window.</Empty>}
      <div className="grid gap-3 lg:grid-cols-2">
        {groups.map(g => (
          <Card key={g.ticket.identifier} className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm leading-snug">{g.ticket.title ?? g.ticket.identifier}</CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-2">
                <a href={g.ticket.url} target="_blank" rel="noopener noreferrer" className="font-mono text-xs hover:text-foreground hover:underline">
                  {g.ticket.identifier}
                </a>
                {g.ticket.state && <StateBadge state={g.ticket.state} />}
                <span className="text-xs">· {relative(g.lastAt)}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2.5 px-4">
              {g.prs.length > 0 && <div className="flex flex-wrap gap-1">{g.prs.map(pr => <PrChip key={pr.url} pr={pr} />)}</div>}
              <ul className="space-y-1">
                {g.sessions.slice(0, 6).map(s => (
                  <li key={s.sessionId} className="flex min-w-0 items-center gap-2 text-xs">
                    {s.live ? <Dot tone={s.live.status === "busy" ? "run" : "ok"} pulse={s.live.status === "busy"} /> : <KindIcon kind={s.kind} />}
                    <span className="truncate">{s.title ?? "Untitled session"}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground">{relative(s.lastAt)}</span>
                  </li>
                ))}
                {g.sessions.length > 6 && <li className="text-xs text-muted-foreground">+{g.sessions.length - 6} more</li>}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};

const Empty = ({ children }: { children: React.ReactNode }) => (
  <Card className="items-center py-12 text-sm text-muted-foreground">{children}</Card>
);

export const Sessions = ({ days, now }: { days: number; now: number }) => {
  const [view, setViewState] = useState<View>(() => {
    const sub = window.location.hash.split("/")[1];
    return sub === "recent" || sub === "tickets" ? sub : "live";
  });
  const setView = (v: View) => {
    setViewState(v);
    window.history.replaceState(null, "", v === "live" ? "#sessions" : `#sessions/${v}`);
  };
  const [kind, setKind] = useState<KindFilter>("all");
  const { data, error } = usePolled<SessionsOverview>(`/api/claude/sessions?days=${days}`);

  const sessions = useMemo(() => (data?.sessions ?? []).filter(s => kind === "all" || s.kind === kind), [data, kind]);
  const live = sessions.filter(s => s.live);

  if (!data) {
    return error ? <Empty>Couldn't load sessions: {error}</Empty> : <Skeleton className="h-96 rounded-xl" />;
  }
  const counts = { live: live.length, recent: sessions.length, tickets: byTicket(sessions, false).length };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Chips<View>
          value={view}
          onChange={setView}
          options={[
            ["live", `Live ${counts.live}`],
            ["recent", `Recent ${counts.recent}`],
            ["tickets", `By ticket ${counts.tickets}`]
          ]}
        />
        <div className="flex items-center gap-1">
          {(["all", "interactive", "gene", "headless"] as const).map(k => {
            const Icon = k === "all" ? null : KIND_ICON[k];
            return (
              <Badge
                key={k}
                asChild
                variant={kind === k ? "default" : "outline"}
                className="cursor-pointer gap-1 font-normal"
              >
                <button type="button" onClick={() => setKind(k)}>
                  {Icon && <Icon />}
                  {k === "all" ? "All" : KIND_LABEL[k]}
                </button>
              </Badge>
            );
          })}
        </div>
      </div>
      {data.scanning && <p className="px-1 text-xs text-muted-foreground">Reading transcripts…</p>}
      {view === "live" &&
        (live.length === 0 ? (
          <Empty>No Claude Code session is running right now.</Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {live.map(s => <LiveCard key={s.sessionId} s={s} now={now} />)}
          </div>
        ))}
      {view === "recent" && <Recent sessions={sessions} />}
      {view === "tickets" && <Tickets sessions={sessions} />}
      <p className="px-1 text-[11px] text-muted-foreground">
        From {data.root} · {data.sessions.length} sessions in {data.windowDays === 1 ? "24h" : `${data.windowDays}d`}
      </p>
    </div>
  );
};
