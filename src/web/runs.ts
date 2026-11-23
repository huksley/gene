/**
 * Rebuild agent runs from the activity log (issue_log) for the web UI. Pure: rows in,
 * runs out — the store query lives in overview.ts.
 *
 * A run is a `dispatch` row and everything logged for that ticket until its next
 * `dispatch`. A program run is preceded by `program-fired` (who fired it, why) and closed
 * by `program-run-done` (its result); a coding run is closed by the agent's terminal row.
 */
import type { RunOutcome, RunView } from "./types.ts";

export type LogRow = {
  identifier: string;
  event: string;
  detail: string;
  createdAt: string;
  data?: unknown;
  tokensIn?: number | null;
  tokensOut?: number | null;
};

/** The agent's terminal rows (invoke.ts) and what each means for the run. */
const AGENT_END: Record<string, RunOutcome> = {
  "agent-done": "done",
  "agent-error": "error",
  "agent-stalled": "stalled",
  "agent-cancelled": "cancelled",
  "agent-interrupted": "interrupted"
};

const PROGRAM_RESULTS = new Set<RunOutcome>(["ok", "incomplete", "blocked", "cancelled", "error"]);

/** Rows worth showing on a run as a note (the rest are bookkeeping). */
const NOTE_EVENTS = new Set([
  "cr-linked",
  "clarification",
  "merged",
  "draft-enforced",
  "child-ticket-created",
  "run-notes-updated",
  "parent-complete",
  "stalled",
  "reset"
]);

const URL_RE = /https?:\/\/[^\s)<>"'\]]+/g;

const field = (data: unknown, key: string): string | undefined => {
  if (data && typeof data === "object" && key in data) {
    const value = (data as Record<string, unknown>)[key];
    return value === undefined || value === null ? undefined : String(value);
  }
  return undefined;
};

/** `processing → group/app [gitlab] ⎇ branch` → `processing`. */
const intentOf = (detail: string): string => /^(.*?)\s*→/.exec(detail)?.[1]?.trim() || detail;

/** `source: trigger — deploy finished (from: Todo)` → the reason, when there is one. */
const reasonOf = (detail: string): string | undefined =>
  /^source:\s*\S+\s+—\s+(.*?)(?:\s+\(from: [^)]*\))?$/.exec(detail)?.[1];

const durationBetween = (from: string, to: string): number | undefined => {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

/**
 * Group log rows (any order of identifiers, but ascending within one) into runs, newest
 * first. `running` names the identifiers with a live agent right now: the latest open
 * run of one of those reads `running` instead of `dispatched`.
 */
export const buildRuns = (rows: LogRow[], running: ReadonlySet<string> = new Set()): RunView[] => {
  const byId = new Map<string, LogRow[]>();
  for (const row of rows) {
    const list = byId.get(row.identifier);
    if (list) list.push(row);
    else byId.set(row.identifier, [row]);
  }

  const runs: RunView[] = [];
  for (const [identifier, list] of byId) {
    let current: (RunView & { closedByProgram?: boolean }) | null = null;
    let pendingFire: { source?: string; reason?: string } | null = null;
    const own: RunView[] = [];

    for (const row of list) {
      if (row.event === "program-fired") {
        pendingFire = { source: field(row.data, "source"), reason: reasonOf(row.detail) };
        continue;
      }
      if (row.event === "dispatch") {
        const intent = intentOf(row.detail);
        current = {
          identifier,
          title: field(row.data, "title"),
          kind: intent === "program" ? "program" : "ticket",
          intent,
          ...(pendingFire?.source ? { source: pendingFire.source } : {}),
          ...(pendingFire?.reason ? { reason: pendingFire.reason } : {}),
          startedAt: row.createdAt,
          outcome: "dispatched",
          notes: [],
          links: []
        };
        pendingFire = null;
        own.push(current);
        continue;
      }
      if (!current) continue; // rows from before the window's first dispatch

      for (const url of row.detail.match(URL_RE) ?? []) {
        if (!current.links.includes(url)) current.links.push(url);
      }

      if (row.event === "agent-start") {
        current.outcome = "running";
      } else if (row.event in AGENT_END) {
        let outcome = AGENT_END[row.event]!;
        if (outcome === "error" && /timed out/.test(row.detail)) outcome = "timeout";
        // A program's own result (program-run-done) is the better summary; keep it.
        if (!current.closedByProgram) {
          current.outcome = outcome;
          current.detail = row.detail;
        }
        current.endedAt = row.createdAt;
        if (row.tokensIn != null || row.tokensOut != null) {
          current.tokens = { in: Number(row.tokensIn ?? 0), out: Number(row.tokensOut ?? 0) };
        }
      } else if (row.event === "program-run-done") {
        const result = field(row.data, "last_result") as RunOutcome | undefined;
        if (result && PROGRAM_RESULTS.has(result)) current.outcome = result;
        current.detail = row.detail;
        current.endedAt = row.createdAt;
        current.closedByProgram = true;
      } else if (NOTE_EVENTS.has(row.event)) {
        current.notes.push({ event: row.event, detail: row.detail, at: row.createdAt });
        if (row.event === "clarification" && current.outcome === "running") current.outcome = "blocked";
      }
    }

    own.forEach((run, i) => {
      const latest = i === own.length - 1;
      if (run.outcome === "running" && !(latest && running.has(identifier))) {
        // Spawned but no outcome, and no live agent: the daemon lost it.
        run.outcome = "interrupted";
      } else if (run.outcome === "dispatched" && latest && running.has(identifier)) {
        run.outcome = "running";
      }
      if (run.endedAt) run.durationMs = durationBetween(run.startedAt, run.endedAt);
      delete (run as { closedByProgram?: boolean }).closedByProgram;
    });
    runs.push(...own);
  }

  return runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
};

/** The change-request URL in a `cr-linked` detail ("linked <url> to ABC-1"). */
export const changeRequestUrl = (detail: string): string | undefined => detail.match(URL_RE)?.[0];
