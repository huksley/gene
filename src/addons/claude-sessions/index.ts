/**
 * Claude sessions addon for the web UI (GENE_UI_CLAUDE_SESSIONS=true): the Claude Code
 * sessions on this machine — running now and recent — with the tickets each touches, its
 * recent activity, and the PRs it opened.
 *
 *   GET /api/claude/sessions?days=N   {@link SessionsOverview}
 *
 * Reads `$CLAUDE_CONFIG_DIR` (default `~/.claude`): the live-session registry and the
 * transcripts. Read-only. It puts your prompts on the page, hence opt-in — and behind
 * GENE_UI_TOKEN when the UI binds beyond localhost.
 */
import { getDb } from "../../db.ts";
import logger from "../../logger.ts";
import { monitor } from "../../monitor.ts";
import { tracker, type Issue } from "../../tracker/index.ts";
import { unlistedUrl } from "../../web/overview.ts";
import type { WebAddon } from "../../web/server.ts";
import { newSession, prLabel, sessionKind, ticketCandidates, tokenTotals, type SessionAcc } from "./parse.ts";
import { prStatus, refreshPrStatuses } from "./prs.ts";
import { claudeRoot, readLiveSessions, TranscriptScanner, type LiveSession } from "./scanner.ts";
import type { SessionsOverview, SessionTicket, SessionView } from "./types.ts";

const DAY = 86_400_000;
const MAX_DAYS = 30;
const DEFAULT_DAYS = 7;
const MAX_SESSIONS = 400;
/** Re-scan at most this often; polls in between get the last result. */
const RESCAN_MS = 5_000;

const root = claudeRoot();
const scanner = new TranscriptScanner(root);

type Scan = { at: number; days: number; sessions: SessionAcc[]; live: LiveSession[] };
let last: Scan | null = null;
let inflight: Promise<Scan> | null = null;

const runScan = (days: number): Promise<Scan> => {
  inflight ??= (async () => {
    const now = Date.now();
    const [sessions, live] = await Promise.all([
      scanner.scan(now - days * DAY, now - MAX_DAYS * DAY),
      readLiveSessions(root)
    ]);
    last = { at: Date.now(), days, sessions, live };
    return last;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
};

/**
 * The latest scan for this window. The first one (or a wider window) is awaited; after
 * that a stale result is served while a fresh scan runs in the background.
 */
const scanFor = async (days: number): Promise<{ scan: Scan; scanning: boolean }> => {
  if (!last || last.days < days) return { scan: await runScan(days), scanning: false };
  if (Date.now() - last.at > RESCAN_MS || last.days !== days) {
    void runScan(days).catch(error =>
      logger.warn(`${logger.tag.web} claude sessions scan failed:`, error instanceof Error ? error.message : error)
    );
    return { scan: last, scanning: last.days !== days };
  }
  return { scan: last, scanning: false };
};

// ─── Tickets ─────────────────────────────────────────────────────────────────

let keysCache: { at: number; keys: Set<string> } | null = null;

/** Team keys ("CLOUD") Gene knows: tracked tickets plus everything in its activity log. */
const knownKeys = async (tracked: Issue[]): Promise<Set<string>> => {
  const keys = new Set<string>();
  const keyOf = (id: string) => id.slice(0, id.lastIndexOf("-")).toUpperCase();
  for (const issue of tracked) {
    if (issue.identifier.includes("-")) keys.add(keyOf(issue.identifier));
    if (issue.teamKey) keys.add(issue.teamKey.toUpperCase());
  }
  if (!keysCache || Date.now() - keysCache.at > 5 * 60_000) {
    try {
      const db = await getDb();
      const res = await db.query<{ identifier: string }>("SELECT DISTINCT identifier FROM issue_log WHERE tracker = $1", [tracker.name]);
      keysCache = { at: Date.now(), keys: new Set(res.rows.filter(r => r.identifier.includes("-")).map(r => keyOf(r.identifier))) };
    } catch {
      keysCache = { at: Date.now(), keys: new Set() };
    }
  }
  for (const key of keysCache.keys) keys.add(key);
  return keys;
};

const projectOf = (cwd: string | undefined): string | undefined => {
  if (!cwd) return undefined;
  const parts = cwd.split("/").filter(Boolean);
  const worktree = parts.indexOf(".worktrees");
  if (worktree !== -1) return parts.slice(worktree + 2).join("/"); // "<host>/<repo>/<ID>" minus host
  const programs = parts.indexOf("programs");
  if (programs > 0 && parts[programs - 1] === ".gene") return `program ${parts[programs + 1] ?? ""}`.trim();
  return parts.at(-1);
};

/**
 * Claude Code's own title, else — for Gene's runs, whose first prompt is Gene's brief —
 * the ticket's title, else the first line of the first prompt.
 */
const titleOf = (acc: SessionAcc, tickets: SessionTicket[]): string | undefined => {
  if (acc.title) return acc.title;
  if (sessionKind(acc) === "gene") {
    const ticket = tickets.find(t => t.via === "worktree") ?? tickets[0];
    const name = ticket?.title ?? acc.geneTitle;
    if (ticket) return name ? `${ticket.identifier} — ${name}` : `Gene run · ${ticket.identifier}`;
    if (acc.geneTitle) return acc.geneTitle;
  }
  return acc.firstPrompt?.split("\n")[0]?.slice(0, 120);
};

const toView = (acc: SessionAcc, live: LiveSession | undefined, tracked: Map<string, Issue>, keys: Set<string>): SessionView => {
  const tickets: SessionTicket[] = ticketCandidates(acc, keys).map(c => {
    const issue = tracked.get(c.identifier);
    const url = issue?.url ?? unlistedUrl(c.identifier);
    return {
      identifier: c.identifier,
      via: c.via,
      ...(issue ? { title: issue.title, state: issue.stateName } : {}),
      ...(url ? { url } : {})
    };
  });
  const tools = [...acc.tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return {
    sessionId: acc.sessionId,
    title: titleOf(acc, tickets),
    kind: sessionKind(acc),
    entrypoint: acc.entrypoint,
    cwd: acc.cwd ?? live?.cwd,
    project: projectOf(acc.cwd ?? live?.cwd),
    branch: acc.branch,
    version: acc.version,
    startedAt: acc.firstAt,
    lastAt: acc.lastAt,
    ...(live ? { live: { pid: live.pid, status: live.status, name: live.name, since: live.since } } : {}),
    prompts: acc.prompts,
    recentPrompts: acc.recentPrompts,
    lastReply: acc.lastReply,
    tools,
    toolCalls: tools.reduce((n, t) => n + t.count, 0),
    lastTool: acc.lastTool,
    tokens: tokenTotals(acc),
    costUsd: acc.costUsd,
    lines: acc.lines,
    tickets,
    prs: [...acc.prs.values()]
      .sort((a, b) => b.at.localeCompare(a.at))
      .map(pr => ({ url: pr.url, label: prLabel(pr.url), repo: pr.repo, at: pr.at, status: prStatus(pr.url) }))
  };
};

export const buildSessions = async (windowDays: number): Promise<SessionsOverview> => {
  const days = Math.min(Math.max(1, Math.floor(windowDays)), MAX_DAYS);
  const { scan, scanning } = await scanFor(days);
  const since = new Date(Date.now() - days * DAY).toISOString();

  const { tickets, programs } = monitor.getTracked();
  const trackedList = [...(tickets ?? []), ...(programs ?? [])];
  const tracked = new Map(trackedList.map(i => [i.identifier.toUpperCase(), i]));
  const keys = await knownKeys(trackedList);
  const live = new Map(scan.live.map(l => [l.sessionId, l]));

  const views: SessionView[] = [];
  const seen = new Set<string>();
  for (const acc of scan.sessions) {
    const isLive = live.has(acc.sessionId);
    // A transcript can be touched (mtime) without new activity; a live one always shows.
    if (!isLive && (!acc.lastAt || acc.lastAt < since)) continue;
    if (!isLive && acc.prompts === 0 && acc.tools.size === 0) continue; // empty / aborted
    seen.add(acc.sessionId);
    views.push(toView(acc, live.get(acc.sessionId), tracked, keys));
  }
  // Live sessions with no transcript yet (just started, nothing said).
  for (const l of scan.live) {
    if (seen.has(l.sessionId)) continue;
    const acc = newSession(l.sessionId);
    if (l.cwd) {
      acc.cwd = l.cwd;
      acc.cwds.add(l.cwd);
    }
    views.push(toView(acc, l, tracked, keys));
  }

  views.sort((a, b) => Number(!!b.live) - Number(!!a.live) || (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
  const shown = views.slice(0, MAX_SESSIONS);
  refreshPrStatuses(shown.flatMap(v => v.prs.map(p => p.url)));

  return { generatedAt: new Date().toISOString(), windowDays: days, root, sessions: shown, scanning };
};

export const claudeSessionsAddon: WebAddon = {
  name: "claude-sessions",
  routes: {
    "/api/claude/sessions": url => buildSessions(Number(url.searchParams.get("days") ?? DEFAULT_DAYS) || DEFAULT_DAYS)
  }
};
