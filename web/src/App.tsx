import { useEffect, useMemo, useState } from "react";
import { LogOut, Moon, RefreshCw, Sun } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Activity } from "@/components/activity";
import { Programs } from "@/components/programs";
import { Tickets } from "@/components/tickets";
import { Sessions } from "@/components/sessions";
import { TokenGate } from "@/components/token-gate";
import { Dot } from "@/components/status";
import { TicketRefsContext, type TicketRefs } from "@/components/markdown";
import { getToken, prefs, setToken } from "@/lib/api";
import { relative, tokens as fmtTokens } from "@/lib/format";
import { usePolled } from "@/lib/use-polled";
import { useTheme } from "@/lib/use-theme";
import type { CommentView, Overview } from "@/lib/types";
import { cn } from "@/lib/utils";

const RANGES = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" }
] as const;

const TABS = ["activity", "programs", "tickets", "sessions"];
/** `#programs` / `#tickets` deep-link a tab. */
const tabFromHash = (): string | null => {
  const t = window.location.hash.slice(1).split("/")[0] ?? "";
  return TABS.includes(t) ? t : null;
};

/** Re-render every second so relative times and the scan countdown stay live. */
const useNow = (): number => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
};

const DaemonStatus = ({ d, now }: { d: Overview["daemon"]; now: number }) => {
  const label = d.paused ? "paused" : d.phase;
  const tone = d.lastError ? "bad" : d.paused ? "warn" : d.phase === "scanning" ? "run" : "ok";
  const next = d.nextScanAt && !d.paused && d.phase !== "scanning" ? Math.max(0, Math.round((d.nextScanAt - now) / 1000)) : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="h-7 gap-2 px-2.5 font-normal">
          <Dot tone={tone} pulse={d.phase === "scanning"} />
          {label}
          {next !== null && <span className="hidden tabular-nums text-muted-foreground sm:inline">· next scan {next}s</span>}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {d.lastError ? `Last scan failed: ${d.lastError}` : `Last scan ${relative(d.lastScanAt, now)} · up since ${relative(d.startedAt, now)}`}
      </TooltipContent>
    </Tooltip>
  );
};

const Stat = ({ title, value, hint }: { title: string; value: React.ReactNode; hint?: React.ReactNode }) => (
  <Card className="gap-0.5 py-3 sm:gap-1 sm:py-4">
    <CardHeader className="gap-0.5 px-3 sm:gap-1.5 sm:px-4">
      <CardDescription className="text-[11px] sm:text-xs">{title}</CardDescription>
      <CardTitle className="text-xl tabular-nums sm:text-2xl">{value}</CardTitle>
    </CardHeader>
    {hint && <CardContent className="line-clamp-2 px-3 text-[11px] text-muted-foreground sm:px-4 sm:text-xs">{hint}</CardContent>}
  </Card>
);

const Stats = ({ data }: { data: Overview }) => {
  const runs = data.runs;
  const good = runs.filter(r => r.outcome === "ok" || r.outcome === "done").length;
  const bad = runs.filter(r => ["error", "interrupted", "timeout", "stalled"].includes(r.outcome)).length;
  const windowTokens = runs.reduce((n, r) => n + (r.tokens ? r.tokens.in + r.tokens.out : 0), 0);
  const activePrograms = new Set(runs.filter(r => r.kind === "program").map(r => r.identifier)).size;
  const byState = new Map<string, number>();
  for (const t of data.tickets) byState.set(t.state, (byState.get(t.state) ?? 0) + 1);
  return (
    <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
      <Stat
        title={`Runs · ${data.windowDays === 1 ? "24h" : `${data.windowDays}d`}`}
        value={runs.length}
        hint={
          <span>
            <span className="text-ok">{good} ok</span> · <span className={cn(bad > 0 && "text-bad")}>{bad} failed</span> ·{" "}
            {data.daemon.running}/{data.daemon.maxConcurrent} running
          </span>
        }
      />
      <Stat title="Programs" value={data.programs.length} hint={`${activePrograms} ran in this window`} />
      <Stat
        title="Tickets"
        value={data.tickets.length}
        hint={[...byState].map(([s, n]) => `${n} ${s}`).join(" · ") || "none open"}
      />
      <Stat title="Tokens · window" value={fmtTokens(windowTokens)} hint={`${fmtTokens(data.tokens.total)} lifetime`} />
    </div>
  );
};

const Loading = () => (
  <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-24 rounded-xl" />
      ))}
    </div>
    <Skeleton className="h-9 w-72" />
    <Skeleton className="h-96 rounded-xl" />
  </div>
);

export function App() {
  const [days, setDays] = useState<number>(() => Number(prefs.get("days")) || 7);
  const [tab, setTab] = useState<string>(() => tabFromHash() ?? prefs.get("tab") ?? "activity");
  useEffect(() => {
    const onHash = () => {
      const t = tabFromHash();
      if (t) setTab(t);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [theme, toggleTheme] = useTheme();
  const { data, error, auth, loading, fetchedAt, refresh } = usePolled<Overview>(`/api/overview?days=${days}`);
  const now = useNow();

  const comments = useMemo(() => {
    const map = new Map<string, CommentView | undefined>();
    for (const i of [...(data?.tickets ?? []), ...(data?.programs ?? [])]) map.set(i.identifier, i.latestComment);
    return map;
  }, [data]);

  // Polls return a fresh object each time; key the context on its content so comments
  // re-render only when what their references link to actually changed.
  const refsKey = useMemo(() => {
    const urls = [...(data?.tickets ?? []), ...(data?.programs ?? [])].map(i => [i.identifier, i.url]);
    return JSON.stringify([data?.ticketRefs?.keys ?? [], data?.ticketRefs?.base ?? null, urls]);
  }, [data]);
  const ticketRefs = useMemo<TicketRefs>(() => {
    const [keys, base, urls] = JSON.parse(refsKey) as [string[], string | null, [string, string][]];
    return { keys, ...(base ? { base } : {}), urls: new Map(urls) };
  }, [refsKey]);

  useEffect(() => {
    const running = data?.daemon.running ?? 0;
    document.title = running > 0 ? `(${running}) Gene` : "Gene";
  }, [data?.daemon.running]);

  if (auth !== "ok") return <TokenGate rejected={auth === "rejected"} onSaved={refresh} />;

  return (
    <TicketRefsContext.Provider value={ticketRefs}>
      <TooltipProvider delayDuration={150}>
        <div className="mx-auto max-w-6xl px-[max(1rem,env(safe-area-inset-left))] pb-16 sm:px-6">
          <header className="sticky top-0 z-10 -mx-4 mb-4 flex items-center gap-2 border-b bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur sm:-mx-6 sm:mb-6 sm:gap-3 sm:px-6">
            <span className="text-xl" aria-hidden>🧬</span>
            <div className="flex min-w-0 items-baseline gap-2">
              <h1 className="font-semibold tracking-tight">Gene</h1>
              {data && (
                <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                  v{data.version} · {data.tracker} · label {data.daemon.label}
                </span>
              )}
            </div>
            {data?.daemon.dryRun && <Badge variant="outline" className="border-warn text-warn">dry-run</Badge>}
            <div className="ml-auto flex items-center gap-1.5">
              {data && <DaemonStatus d={data.daemon} now={now} />}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="Refresh">
                    <RefreshCw className={cn(loading && "animate-spin")} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{fetchedAt ? `Updated ${relative(fetchedAt, now)}` : "Refresh"}</TooltipContent>
              </Tooltip>
              <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label="Toggle theme">
                {theme === "dark" ? <Sun /> : <Moon />}
              </Button>
              {getToken() && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Forget token"
                      onClick={() => {
                        setToken(null);
                        refresh();
                      }}
                    >
                      <LogOut />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Forget the saved token</TooltipContent>
                </Tooltip>
              )}
            </div>
          </header>

          {error && (
            <div className="mb-4 rounded-lg border border-bad/40 bg-bad/10 px-4 py-2 text-sm text-bad">
              Couldn't reach the daemon: {error}
              {data && " — showing the last data."}
            </div>
          )}
          {data && !data.scanned.tickets && (
            <div className="mb-4 rounded-lg border px-4 py-2 text-sm text-muted-foreground">
              Waiting for the first scan to list tickets and programs…
            </div>
          )}

          {!data ? (
            <Loading />
          ) : (
            <div className="space-y-4 sm:space-y-6">
              <Stats data={data} />
              <Tabs
                value={tab}
                onValueChange={v => {
                  setTab(v);
                  prefs.set("tab", v);
                  window.history.replaceState(null, "", `#${v}`);
                }}
                className="gap-4"
              >
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <TabsList className="w-full justify-start overflow-x-auto sm:w-fit [&::-webkit-scrollbar]:hidden">
                    <TabsTrigger value="activity">Activity</TabsTrigger>
                    <TabsTrigger value="programs">
                      Programs <span className="text-muted-foreground tabular-nums">{data.programs.length}</span>
                    </TabsTrigger>
                    <TabsTrigger value="tickets">
                      Tickets <span className="text-muted-foreground tabular-nums">{data.tickets.length}</span>
                    </TabsTrigger>
                    {data.addons.includes("claude-sessions") && <TabsTrigger value="sessions">Sessions</TabsTrigger>}
                  </TabsList>
                  <TabsList aria-label="Time window" className="self-end sm:self-auto">
                    {RANGES.map(r => (
                      <button
                        key={r.days}
                        type="button"
                        onClick={() => {
                          setDays(r.days);
                          prefs.set("days", String(r.days));
                        }}
                        data-state={days === r.days ? "active" : "inactive"}
                        className="h-[calc(100%-1px)] rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm dark:data-[state=active]:bg-input/30"
                      >
                        {r.label}
                      </button>
                    ))}
                  </TabsList>
                </div>
                <TabsContent value="activity">
                  <Activity runs={data.runs} comments={comments} />
                </TabsContent>
                <TabsContent value="programs">
                  <Programs programs={data.programs} />
                </TabsContent>
                <TabsContent value="tickets">
                  <Tickets tickets={data.tickets} />
                </TabsContent>
                {data.addons.includes("claude-sessions") && (
                  <TabsContent value="sessions">
                    <Sessions days={Math.min(days, 30)} now={now} />
                  </TabsContent>
                )}
              </Tabs>
            </div>
          )}
        </div>
      </TooltipProvider>
    </TicketRefsContext.Provider>
  );
}
