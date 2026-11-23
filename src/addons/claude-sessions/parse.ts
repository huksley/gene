/**
 * Fold a Claude Code transcript (`~/.claude/projects/<dir>/<sessionId>.jsonl`) into a
 * small session summary, one record at a time — so the scanner can feed it only the
 * lines appended since its last read. Pure: no I/O.
 *
 * Records used (the rest are skipped):
 *   user / assistant / system  cwd, gitBranch, entrypoint, version, timestamp; prompts,
 *                              replies, tool calls, token usage
 *   ai-title                   the session's title
 *   pr-link                    a PR Claude Code saw the session open
 *   cost-state                 cost and lines changed
 */
import type { SessionKind, SessionPrompt } from "./types.ts";

const RECENT_PROMPTS = 5;
const PROMPT_CHARS = 600;
const REPLY_CHARS = 600;

/** `ABC-123` (any case); filtered against known team keys later. */
const TICKET_RE = /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\b/g;
/** A Gene worktree / program scratch dir ends in the ticket identifier. */
const GENE_DIR_RE = /\/\.gene\/(?:repos\/\.worktrees\/.+|programs)\/([A-Za-z][A-Za-z0-9]{1,9}-\d{1,6})(?:\/|$)/;
const CR_URL_RE = /https?:\/\/[^\s"'<>)\]]+\/(?:pull\/\d+|-\/merge_requests\/\d+)/g;
const CR_CREATE_RE = /\b(?:gh\s+pr\s+create|glab\s+mr\s+create)\b/;

export type TicketCandidate = { identifier: string; via: "worktree" | "branch" | "title" | "prompt"; upper: boolean };

export type SessionAcc = {
  sessionId: string;
  /** The latest working directory, and every one the session used. */
  cwd?: string;
  cwds: Set<string>;
  branch?: string;
  branches: Set<string>;
  entrypoint?: string;
  version?: string;
  firstAt?: string;
  lastAt?: string;
  title?: string;
  firstPrompt?: string;
  /** The ticket title Gene's prompt names (`- **Title:** …` / `# Program: ID — …`). */
  geneTitle?: string;
  prompts: number;
  recentPrompts: SessionPrompt[];
  lastReply?: string;
  tools: Map<string, number>;
  lastTool?: { name: string; at: string };
  /** Usage per assistant message id — a message streams over several records. */
  usage: Map<string, { in: number; out: number }>;
  costUsd?: number;
  lines?: { added: number; removed: number };
  prs: Map<string, { url: string; number?: string; repo?: string; at: string }>;
  /** Prompt mentions, collected as they stream past (prompts aren't kept). */
  mentions: Map<string, boolean>;
  /** tool_use ids of `gh pr create` / `glab mr create` calls awaiting their result. */
  crCreates: Set<string>;
};

export const newSession = (sessionId: string): SessionAcc => ({
  sessionId,
  cwds: new Set(),
  branches: new Set(),
  prompts: 0,
  recentPrompts: [],
  tools: new Map(),
  usage: new Map(),
  prs: new Map(),
  mentions: new Map(),
  crCreates: new Set()
});

const clip = (text: string, n: number): string => {
  const t = text.replace(/\s+\n/g, "\n").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(b => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
};

/**
 * What a human typed, or undefined for records that only look like prompts: tool results,
 * injected context, local command output. A slash command reads as `/name args`.
 */
export const promptText = (content: unknown): string | undefined => {
  if (Array.isArray(content) && content.some(b => b && typeof b === "object" && (b as { type?: string }).type === "tool_result")) {
    return undefined;
  }
  const text = textOf(content).trim();
  if (!text) return undefined;
  const command = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    const name = command[1]!.startsWith("/") ? command[1]! : `/${command[1]}`;
    return args ? `${name} ${args}` : name;
  }
  if (/^<(local-command-|system-reminder|bash-|task-notification|user-prompt-submit-hook)/.test(text)) return undefined;
  if (text.startsWith("Caveat: The messages below")) return undefined;
  return text;
};

const addMentions = (acc: SessionAcc, text: string): void => {
  for (const m of text.matchAll(TICKET_RE)) {
    const id = `${m[1]!.toUpperCase()}-${m[2]}`;
    const upper = m[1] === m[1]!.toUpperCase();
    acc.mentions.set(id, (acc.mentions.get(id) ?? false) || upper);
  }
};

const later = (a: string | undefined, b: string | undefined): string | undefined => (!a ? b : !b ? a : a > b ? a : b);

/** Fold one parsed transcript record into the session. */
export const ingest = (acc: SessionAcc, rec: Record<string, any>): void => {
  const type = rec.type;
  const at: string | undefined = typeof rec.timestamp === "string" ? rec.timestamp : undefined;

  if (type === "ai-title" && typeof rec.aiTitle === "string") {
    acc.title = rec.aiTitle;
    return;
  }
  if (type === "pr-link" && typeof rec.prUrl === "string") {
    acc.prs.set(rec.prUrl, {
      url: rec.prUrl,
      number: rec.prNumber === undefined ? undefined : String(rec.prNumber),
      repo: rec.prRepository,
      at: at ?? acc.lastAt ?? ""
    });
    return;
  }
  if (type === "cost-state") {
    const cost = Number(rec.totalCostUSD);
    if (rec.totalCostUSD !== undefined && Number.isFinite(cost)) acc.costUsd = cost;
    const added = Number(rec.totalLinesAdded);
    if (rec.totalLinesAdded !== undefined && Number.isFinite(added)) {
      acc.lines = { added, removed: Number(rec.totalLinesRemoved ?? 0) || 0 };
    }
    return;
  }
  if (type !== "user" && type !== "assistant" && type !== "system") return;
  // Subagent records belong to their own transcript; a sidechain here is noise.
  if (rec.isSidechain === true) return;

  if (typeof rec.cwd === "string") {
    acc.cwd = rec.cwd;
    acc.cwds.add(rec.cwd);
  }
  if (typeof rec.gitBranch === "string" && rec.gitBranch && rec.gitBranch !== "HEAD") {
    acc.branch = rec.gitBranch;
    acc.branches.add(rec.gitBranch);
  }
  if (typeof rec.entrypoint === "string") acc.entrypoint = rec.entrypoint;
  if (typeof rec.version === "string") acc.version = rec.version;
  if (at) {
    if (!acc.firstAt || at < acc.firstAt) acc.firstAt = at;
    acc.lastAt = later(acc.lastAt, at);
  }

  const message = rec.message;
  if (!message || typeof message !== "object") return;

  if (type === "user") {
    const content = message.content;
    // Results of `gh pr create` / `glab mr create`: the URL it printed is the PR.
    if (Array.isArray(content) && acc.crCreates.size > 0) {
      for (const block of content) {
        if (block?.type === "tool_result" && acc.crCreates.has(block.tool_use_id)) {
          acc.crCreates.delete(block.tool_use_id);
          const out = typeof block.content === "string" ? block.content : textOf(block.content);
          for (const url of out.match(CR_URL_RE) ?? []) {
            if (!acc.prs.has(url)) acc.prs.set(url, { url, at: at ?? acc.lastAt ?? "" });
          }
        }
      }
    }
    if (rec.isMeta === true) return;
    const text = promptText(content);
    if (text === undefined) return;
    acc.prompts += 1;
    if (acc.firstPrompt === undefined) {
      acc.firstPrompt = clip(text, PROMPT_CHARS);
      const named = /^- \*\*Title:\*\* (.+)$/m.exec(text)?.[1] ?? /^# Program: \S+ — (.+)$/m.exec(text)?.[1];
      if (named) acc.geneTitle = named.trim();
    }
    acc.recentPrompts.push({ at: at ?? acc.lastAt ?? "", text: clip(text, PROMPT_CHARS) });
    if (acc.recentPrompts.length > RECENT_PROMPTS) acc.recentPrompts.shift();
    addMentions(acc, text);
    return;
  }

  if (type === "assistant") {
    const id = typeof message.id === "string" ? message.id : rec.uuid;
    const u = message.usage;
    if (u && id) {
      acc.usage.set(id, {
        in: Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
        out: Number(u.output_tokens ?? 0)
      });
    }
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        acc.lastReply = clip(block.text, REPLY_CHARS);
      } else if (block?.type === "tool_use" && typeof block.name === "string") {
        acc.tools.set(block.name, (acc.tools.get(block.name) ?? 0) + 1);
        acc.lastTool = { name: block.name, at: at ?? acc.lastAt ?? "" };
        const command = block.input?.command;
        if (typeof command === "string" && CR_CREATE_RE.test(command) && typeof block.id === "string") {
          acc.crCreates.add(block.id);
        }
      }
    }
  }
};

/** Interactive, Gene's own `claude -p`, or some other headless run. */
export const sessionKind = (acc: Pick<SessionAcc, "entrypoint" | "cwd" | "cwds">): SessionKind => {
  const dirs = acc.cwds.size > 0 ? [...acc.cwds] : acc.cwd ? [acc.cwd] : [];
  if (dirs.some(d => /\/\.gene\/(repos\/\.worktrees|programs)\//.test(d))) return "gene";
  if (!acc.entrypoint || acc.entrypoint === "cli" || /vscode|jetbrains|desktop|ide/.test(acc.entrypoint)) return "interactive";
  return "headless";
};

/**
 * The tickets a session touches, strongest link first and each identifier once. `known`
 * holds team keys ("CLOUD") Gene knows from its tracker: a branch or prompt mention
 * counts only with a known key (or, with no keys known, when written in capitals) — so
 * `utf-8` or `gpt-4` never read as tickets. A Gene worktree path always counts.
 */
export const ticketCandidates = (acc: SessionAcc, known: ReadonlySet<string>): TicketCandidate[] => {
  const out = new Map<string, TicketCandidate>();
  const accept = (id: string, upper: boolean): boolean => {
    const key = id.slice(0, id.lastIndexOf("-"));
    return known.size > 0 ? known.has(key) : upper;
  };
  const add = (c: TicketCandidate) => {
    if (!out.has(c.identifier)) out.set(c.identifier, c);
  };

  for (const dir of acc.cwds.size > 0 ? acc.cwds : acc.cwd ? [acc.cwd] : []) {
    const gene = GENE_DIR_RE.exec(dir)?.[1];
    if (gene) add({ identifier: gene.toUpperCase(), via: "worktree", upper: true });
  }
  for (const branch of acc.branches) {
    for (const m of branch.matchAll(TICKET_RE)) {
      const id = `${m[1]!.toUpperCase()}-${m[2]}`;
      const upper = m[1] === m[1]!.toUpperCase();
      if (accept(id, upper)) add({ identifier: id, via: "branch", upper });
    }
  }
  for (const m of (acc.title ?? "").matchAll(TICKET_RE)) {
    const id = `${m[1]!.toUpperCase()}-${m[2]}`;
    const upper = m[1] === m[1]!.toUpperCase();
    if (accept(id, upper)) add({ identifier: id, via: "title", upper });
  }
  for (const [id, upper] of acc.mentions) {
    if (accept(id, upper)) add({ identifier: id, via: "prompt", upper });
  }
  return [...out.values()];
};

export const tokenTotals = (acc: SessionAcc): { in: number; out: number } => {
  let tin = 0;
  let tout = 0;
  for (const u of acc.usage.values()) {
    tin += u.in;
    tout += u.out;
  }
  return { in: tin, out: tout };
};

/** "!12" for a GitLab MR, "#34" for a GitHub PR. */
export const prLabel = (url: string): string => {
  const mr = /merge_requests\/(\d+)/.exec(url);
  if (mr) return `!${mr[1]}`;
  const pr = /\/pull\/(\d+)/.exec(url);
  return pr ? `#${pr[1]}` : url;
};
