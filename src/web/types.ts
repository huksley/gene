/**
 * The web UI's API contract — `GET /api/overview` returns an {@link Overview}. Types
 * only (no imports, no runtime), so both the daemon (src/web/) and the browser bundle
 * (web/src/) import this one file.
 */

/**
 * How a run ended. Program runs report the program lifecycle's own result
 * (ok / incomplete / blocked / cancelled / error); coding runs report the agent's
 * (done / error / stalled / timeout / cancelled / interrupted). `running` is live,
 * `dispatched` was logged but never spawned (dry-run, deferred, or lost).
 */
export type RunOutcome =
  | "running"
  | "dispatched"
  | "ok"
  | "done"
  | "incomplete"
  | "blocked"
  | "cancelled"
  | "error"
  | "stalled"
  | "timeout"
  | "interrupted";

/** One agent run reconstructed from the activity log: a `dispatch` row up to the next. */
export type RunView = {
  identifier: string;
  title?: string;
  /** The ticket on the tracker, when known (listed now, or derivable for Linear). */
  url?: string;
  kind: "program" | "ticket";
  /** processing / resume / feedback / review-fix / continue / retry, or "program". */
  intent: string;
  /** Who fired a program run: manual / trigger / comment. */
  source?: string;
  /** Why it fired — a trigger's reason, the `!gene` comment. */
  reason?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  outcome: RunOutcome;
  /** The terminal row's human detail ("→ Todo (ok)", "exited 1 (timed out…)"). */
  detail?: string;
  tokens?: { in: number; out: number };
  /** Notable things the run did, in order: a CR linked, a clarification asked… */
  notes: { event: string; detail: string; at: string }[];
  /** Change-request / other URLs found in the run's log rows. */
  links: string[];
};

/** A tracker comment, trimmed for display (Gene's marker stripped). */
export type CommentView = {
  body: string;
  createdAt: string;
  authorName: string | null;
  isAgent: boolean;
};

/** The live in-memory agent for a ticket, when the daemon has one this session. */
export type AgentView = {
  status: string;
  stage: string;
  lastEvent: string;
  startedAt?: number;
  finishedAt?: number;
  toolCount: number;
};

type IssueBase = {
  identifier: string;
  title: string;
  /** The ticket on the tracker (Linear issue / Trello card). */
  url: string;
  state: string;
  updatedAt: string;
  team: string;
  project: string | null;
  assignee: string | null;
  agent?: AgentView;
  /** Gene's newest comment on the ticket — a program's last run resolution. */
  latestComment?: CommentView;
  /** Runs in the window, newest first. */
  runs: RunView[];
};

export type TicketView = IssueBase & {
  /** The last change request Gene linked to the ticket (any time). */
  changeRequest?: string;
};

export type ProgramView = IssueBase & {
  lastFiredAt?: string;
  lastResult?: string;
  lastSource?: string;
  trigger?: {
    status: string;
    summary?: string;
    error?: string;
    nextCheckAt?: number;
    lastCheckAt?: number;
    lastOutcome?: string;
    lastReason?: string;
    armed?: boolean;
  };
};

export type Overview = {
  version: string;
  /** Addons this daemon serves (e.g. "claude-sessions"), each with its own tab. */
  addons: string[];
  generatedAt: string;
  tracker: string;
  /** How far back `runs` reaches. */
  windowDays: number;
  daemon: {
    phase: string;
    paused: boolean;
    dryRun: boolean;
    startedAt: number;
    lastScanAt?: number;
    nextScanAt?: number;
    lastError?: string;
    maxConcurrent: number;
    running: number;
    label: string;
    assignee: string;
  };
  tokens: { in: number; out: number; total: number };
  /** False until the daemon's first scan has listed tickets / programs. */
  scanned: { tickets: boolean; programs: boolean };
  tickets: TicketView[];
  programs: ProgramView[];
  /** Every run in the window, newest first. */
  runs: RunView[];
};
