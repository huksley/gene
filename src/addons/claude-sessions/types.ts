/**
 * The Claude sessions addon's API contract — `GET /api/claude/sessions` returns
 * {@link SessionsOverview}. Types only, shared with the browser bundle (web/src/).
 */

/** How a session was started: you in a terminal/IDE, Gene's `claude -p`, or another headless run. */
export type SessionKind = "interactive" | "gene" | "headless";

/** How a ticket was tied to a session — strongest first. */
export type TicketLinkVia = "worktree" | "branch" | "title" | "prompt";

export type PrStatus = {
  state: "open" | "merged" | "closed" | "locked";
  isDraft: boolean;
  ci: "success" | "failed" | "running" | "none";
  ciUrl?: string;
  checkedAt: string;
};

export type SessionPr = {
  url: string;
  /** "!12" / "#34". */
  label: string;
  repo?: string;
  at: string;
  /** Live state from the forge, once looked up (undefined until then, or when it can't be). */
  status?: PrStatus;
};

export type SessionTicket = {
  identifier: string;
  via: TicketLinkVia;
  /** Known when Gene tracks the ticket (or it's derivable from the tracker). */
  title?: string;
  url?: string;
  state?: string;
};

export type SessionPrompt = { at: string; text: string };

export type SessionView = {
  sessionId: string;
  title?: string;
  kind: SessionKind;
  /** The raw entrypoint (cli, sdk-cli, claude-vscode, …). */
  entrypoint?: string;
  cwd?: string;
  /** Last path segments of cwd, for display ("nest", "nest.datacrunch.io/CLOUD-2629"). */
  project?: string;
  branch?: string;
  version?: string;
  startedAt?: string;
  lastAt?: string;
  /** Set while a Claude Code process is running this session right now. */
  live?: { pid: number; status: string; name?: string; since?: number };
  prompts: number;
  /** The latest few prompts, newest last. */
  recentPrompts: SessionPrompt[];
  /** The latest assistant text, trimmed. */
  lastReply?: string;
  tools: { name: string; count: number }[];
  toolCalls: number;
  lastTool?: { name: string; at: string };
  tokens: { in: number; out: number };
  costUsd?: number;
  lines?: { added: number; removed: number };
  tickets: SessionTicket[];
  prs: SessionPr[];
};

export type SessionsOverview = {
  generatedAt: string;
  windowDays: number;
  /** Where the sessions were read from. */
  root: string;
  /** Live sessions first, then by last activity. */
  sessions: SessionView[];
  /** True while the first full scan is still running (sessions may be partial). */
  scanning: boolean;
};
