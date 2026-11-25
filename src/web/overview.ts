/**
 * Assemble the web UI's {@link Overview}: the tickets and programs the last scan listed
 * (monitor), live agents (monitor), runs rebuilt from the activity log, program status
 * (program_state), and each ticket's newest Gene comment.
 *
 * Comments are the one thing the scan doesn't already hold, and reading them costs a
 * tracker call per ticket. They're cached and refreshed in the background — a page load
 * never waits on the tracker; the next poll picks up what a refresh fetched.
 */
import { env } from "../config.ts";
import { getDb } from "../db.ts";
import logger from "../logger.ts";
import { monitor, type AgentState } from "../monitor.ts";
import { readVersion } from "../sea-assets.ts";
import { tracker, type Issue } from "../tracker/index.ts";
import { buildRuns, changeRequestUrl, type LogRow } from "./runs.ts";
import { linearWorkspaceOf, teamKeyOf, ticketUrl, ticketUrlBase } from "./ticket-url.ts";
import type { AgentView, CommentView, Overview, ProgramView, RunView, TicketView } from "./types.ts";

export const MAX_WINDOW_DAYS = 90;

/** Rows a run is rebuilt from. Agent rows carry the whole event stream in `data` — skip it. */
const readLogWindow = async (sinceIso: string): Promise<LogRow[]> => {
  const db = await getDb();
  const res = await db.query<{
    identifier: string;
    event: string;
    detail: string;
    created_at: Date | string;
    data: unknown;
    tokens_in: string | number | null;
    tokens_out: string | number | null;
  }>(
    `SELECT identifier, event, detail, created_at, tokens_in, tokens_out,
            CASE WHEN event IN ('dispatch', 'program-fired', 'program-run-done') THEN data END AS data
       FROM issue_log
      WHERE tracker = $1 AND created_at >= $2
      ORDER BY id ASC`,
    [tracker.name, sinceIso]
  );
  return res.rows.map(r => ({
    identifier: r.identifier,
    event: r.event,
    detail: r.detail,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    data: r.data ?? undefined,
    tokensIn: r.tokens_in === null ? null : Number(r.tokens_in),
    tokensOut: r.tokens_out === null ? null : Number(r.tokens_out)
  }));
};

/** The last change request linked to each ticket, any time. */
const readChangeRequests = async (): Promise<Map<string, string>> => {
  const db = await getDb();
  const res = await db.query<{ identifier: string; detail: string }>(
    `SELECT DISTINCT ON (identifier) identifier, detail
       FROM issue_log
      WHERE tracker = $1 AND event = 'cr-linked'
      ORDER BY identifier, id DESC`,
    [tracker.name]
  );
  const out = new Map<string, string>();
  for (const row of res.rows) {
    const url = changeRequestUrl(row.detail);
    if (url) out.set(row.identifier, url);
  }
  return out;
};

type ProgramStateRow = { identifier: string; last_fired_at: Date | string | null; last_result: string | null; last_source: string | null };

const readProgramStates = async (): Promise<Map<string, ProgramStateRow>> => {
  const db = await getDb();
  const res = await db.query<ProgramStateRow>(
    "SELECT identifier, last_fired_at, last_result, last_source FROM program_state WHERE tracker = $1",
    [tracker.name]
  );
  return new Map(res.rows.map(r => [r.identifier, r]));
};

const iso = (v: Date | string | null): string | undefined =>
  v === null ? undefined : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

// ─── Latest comment cache ────────────────────────────────────────────────────

/** Re-read a ticket's comments at least this often, even when nothing says it changed. */
const COMMENT_TTL_MS = 5 * 60_000;
const COMMENT_FETCH_CONCURRENCY = 3;

type CommentEntry = { fetchedAt: number; updatedAt: string; comment?: CommentView };
const commentCache = new Map<string, CommentEntry>();
let refreshing: Promise<void> | null = null;

const stripMarker = (body: string): string => body.split(env.AGENT_MARKER).join("").trim();

/** Gene's newest comment on the ticket, else the newest comment at all. */
const pickComment = async (issue: Issue): Promise<CommentView | undefined> => {
  const comments = await tracker.getComments(issue);
  const chosen = comments.findLast(c => c.isAgent) ?? comments.at(-1);
  if (!chosen) return undefined;
  return { body: stripMarker(chosen.body), createdAt: chosen.createdAt, authorName: chosen.authorName, isAgent: chosen.isAgent };
};

/**
 * A cached comment is stale when the ticket changed since, a run ended after it was read
 * (the run's resolution comment is likely new), or it simply aged out.
 */
const isStale = (entry: CommentEntry | undefined, issue: Issue, lastRunEnd: number | undefined, now: number): boolean =>
  entry === undefined ||
  entry.updatedAt !== issue.updatedAt ||
  (lastRunEnd !== undefined && lastRunEnd > entry.fetchedAt) ||
  now - entry.fetchedAt > COMMENT_TTL_MS;

/** Refresh stale comments in the background; one refresh at a time. */
const refreshComments = (stale: Issue[]): void => {
  if (refreshing || stale.length === 0) return;
  const queue = [...stale];
  const worker = async (): Promise<void> => {
    for (let issue = queue.shift(); issue; issue = queue.shift()) {
      try {
        const comment = await pickComment(issue);
        commentCache.set(issue.identifier, { fetchedAt: Date.now(), updatedAt: issue.updatedAt, comment });
      } catch (error) {
        logger.warn(`${logger.tag.web} [${issue.identifier}] could not read comments:`, error instanceof Error ? error.message : error);
        // Back off: keep whatever we had, retry after the TTL.
        const prior = commentCache.get(issue.identifier);
        commentCache.set(issue.identifier, { fetchedAt: Date.now(), updatedAt: issue.updatedAt, comment: prior?.comment });
      }
    }
  };
  refreshing = Promise.all(Array.from({ length: COMMENT_FETCH_CONCURRENCY }, worker))
    .then(() => undefined)
    .finally(() => {
      refreshing = null;
    });
};

/** The Linear workspace slug, read off a listed issue's URL once one has been seen. */
let detectedWorkspace: string | undefined;

/** `LINEAR_WORKSPACE` when set, else the workspace the tracked tickets' URLs point at. */
const linearWorkspace = (): string | undefined => {
  if (env.LINEAR_WORKSPACE) return env.LINEAR_WORKSPACE;
  if (!detectedWorkspace) {
    const { tickets, programs } = monitor.getTracked();
    for (const issue of [...(tickets ?? []), ...(programs ?? [])]) {
      detectedWorkspace = linearWorkspaceOf(issue.url);
      if (detectedWorkspace) break;
    }
  }
  return detectedWorkspace;
};

/** A ticket's URL from its identifier alone, for tickets no longer listed. */
export const unlistedUrl = (identifier: string): string | undefined =>
  ticketUrl(tracker.name, identifier, tracker.name === "linear" ? linearWorkspace() : undefined);

// ─── Assembly ────────────────────────────────────────────────────────────────

const agentView = (agent: AgentState | undefined): AgentView | undefined =>
  agent && agent.status !== "idle"
    ? {
        status: agent.status,
        stage: agent.stage,
        lastEvent: agent.lastEvent,
        startedAt: agent.startedAt,
        finishedAt: agent.finishedAt,
        toolCount: agent.toolCount
      }
    : undefined;

const baseView = (issue: Issue, agents: Map<string, AgentState>, runs: RunView[]) => ({
  identifier: issue.identifier,
  title: issue.title,
  url: issue.url,
  state: issue.stateName,
  updatedAt: issue.updatedAt,
  team: issue.teamName || issue.teamKey,
  project: issue.projectName,
  assignee: issue.assigneeName,
  agent: agentView(agents.get(issue.identifier)),
  latestComment: commentCache.get(issue.identifier)?.comment,
  runs
});

export const buildOverview = async (windowDays: number): Promise<Omit<Overview, "addons">> => {
  const days = Math.min(Math.max(1, Math.floor(windowDays)), MAX_WINDOW_DAYS);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const state = monitor.getState();
  const agents = new Map(state.agents.map(a => [a.id, a]));
  const running = new Set(state.agents.filter(a => a.status === "running" || a.status === "queued").map(a => a.id));

  const [rows, crs, programStates] = await Promise.all([readLogWindow(since), readChangeRequests(), readProgramStates()]);
  const runs = buildRuns(rows, running);
  const runsById = new Map<string, RunView[]>();
  for (const run of runs) {
    const list = runsById.get(run.identifier);
    if (list) list.push(run);
    else runsById.set(run.identifier, [run]);
  }

  const { tickets: trackedTickets, programs: trackedPrograms } = monitor.getTracked();
  const now = Date.now();
  const stale: Issue[] = [];
  for (const issue of [...(trackedPrograms ?? []), ...(trackedTickets ?? [])]) {
    const lastEnd = runsById.get(issue.identifier)?.find(r => r.endedAt)?.endedAt;
    if (isStale(commentCache.get(issue.identifier), issue, lastEnd ? Date.parse(lastEnd) : undefined, now)) {
      stale.push(issue);
    }
  }
  refreshComments(stale);

  const tickets: TicketView[] = (trackedTickets ?? []).map(issue => ({
    ...baseView(issue, agents, runsById.get(issue.identifier) ?? []),
    ...(crs.has(issue.identifier) ? { changeRequest: crs.get(issue.identifier) } : {})
  }));

  const programs: ProgramView[] = (trackedPrograms ?? []).map(issue => {
    const ps = programStates.get(issue.identifier);
    const trigger = agents.get(issue.identifier)?.trigger;
    return {
      ...baseView(issue, agents, runsById.get(issue.identifier) ?? []),
      lastFiredAt: ps ? iso(ps.last_fired_at) : undefined,
      lastResult: ps?.last_result ?? undefined,
      lastSource: ps?.last_source ?? undefined,
      trigger: trigger
        ? {
            status: trigger.status,
            summary: trigger.summary,
            error: trigger.error,
            nextCheckAt: trigger.nextCheckAt,
            lastCheckAt: trigger.lastCheckAt,
            lastOutcome: trigger.lastOutcome,
            lastReason: trigger.lastReason,
            armed: trigger.armed
          }
        : undefined
    };
  });

  // Titles for runs of tickets no longer listed (done, removed) come from the dispatch row;
  // for listed ones prefer the live title.
  const listed = new Map([...(trackedTickets ?? []), ...(trackedPrograms ?? [])].map(i => [i.identifier, i]));
  for (const run of runs) {
    const issue = listed.get(run.identifier);
    if (issue) run.title = issue.title;
    const url = issue?.url ?? run.url ?? unlistedUrl(run.identifier);
    if (url) run.url = url;
  }

  const keys = new Set<string>();
  for (const identifier of [...listed.keys(), ...runsById.keys()]) {
    const key = teamKeyOf(identifier);
    if (key) keys.add(key);
  }
  const base = tracker.name === "linear" ? ticketUrlBase(tracker.name, linearWorkspace()) : undefined;

  const d = state.daemon;
  return {
    version: readVersion(),
    generatedAt: new Date().toISOString(),
    tracker: tracker.name,
    windowDays: days,
    daemon: {
      phase: d.phase,
      paused: d.paused,
      dryRun: d.dryRun,
      startedAt: d.startedAt,
      lastScanAt: d.lastScanAt,
      nextScanAt: d.nextScanAt,
      lastError: d.lastError,
      maxConcurrent: d.maxConcurrent,
      running: state.agents.filter(a => a.status === "running").length,
      label: d.label,
      assignee: d.assignee
    },
    tokens: state.tokens,
    scanned: { tickets: trackedTickets !== null, programs: trackedPrograms !== null },
    tickets,
    programs,
    runs,
    ticketRefs: { keys: [...keys].sort(), ...(base ? { base } : {}) }
  };
};
