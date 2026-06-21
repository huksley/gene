/**
 * Environment + constants for the Gene pipeline. Hand-rolled (no zod) to keep
 * runtime dependencies few — the state store (db.ts) is embedded PGlite by default,
 * with `pg` for an external Postgres — and let Node execute the TypeScript directly. Invalid values
 * collect into a list and exit(1) with a friendly message rather than throwing
 * deep in a module.
 *
 * Values are read from the process environment. In development `node
 * --env-file-if-exists` populates it from `.env.development`; for the standalone
 * binary the bootstrap import below fills any unset keys from a local `gene.config`
 * (env always wins). Either way, by the time this module evaluates, process.env is
 * authoritative.
 */

import "./bootstrap.ts";
import path from "node:path";
import logger from "./logger.ts";

const problems: string[] = [];

const str = (key: string, fallback: string): string => {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
};

/**
 * A single directive/marker token: an optional leading sigil (! @ # /) then
 * letters, digits, `-` or `_`. Rejects spaces and other special symbols so the
 * value is unambiguous to match and safe to splice into a RegExp (directives.ts).
 */
const term = (key: string, fallback: string): string => {
  const raw = process.env[key];
  const val = raw === undefined || raw.trim() === "" ? fallback : raw.trim();
  if (!/^[!@#/]?[\w-]+$/.test(val)) {
    problems.push(`${key}: expected a single term (optional !@#/ sigil, then letters/digits/-/_), got "${val}"`);
  }
  return val;
};

const optional = (key: string): string | undefined => {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
};

const int = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    problems.push(`${key}: expected a non-negative integer, got "${raw}"`);
    return fallback;
  }
  return parsed;
};

const bool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(v)) {
    return false;
  }
  problems.push(`${key}: expected a boolean (true/false), got "${raw}"`);
  return fallback;
};

const list = (key: string): string[] => {
  const raw = optional(key);
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
};

/**
 * Which issue tracker Gene drives (GENE_TRACKER). Tracker-specific settings are
 * namespaced by the active tracker's prefix (LINEAR_* / TRELLO_*), so the exported
 * names below stay tracker-neutral and every downstream consumer is unchanged —
 * only the env *keys* differ per tracker.
 */
const trackerRaw = str("GENE_TRACKER", "linear").toLowerCase();
const TRACKER: "linear" | "trello" = trackerRaw === "trello" ? "trello" : "linear";
if (trackerRaw !== "linear" && trackerRaw !== "trello") {
  problems.push(`GENE_TRACKER: expected "linear" or "trello", got "${trackerRaw}"`);
}
const TP = TRACKER === "trello" ? "TRELLO_" : "LINEAR_";

export const env = {
  TRACKER,

  // Linear backend (read when GENE_TRACKER=linear).
  LINEAR_API_KEY: optional("LINEAR_API_KEY"),
  LINEAR_WORKSPACE: optional("LINEAR_WORKSPACE"),
  // Comment patterns that must NOT wake Gene up (see ignore.ts for the syntax).
  LINEAR_IGNORE_COMMENTS: optional("LINEAR_IGNORE_COMMENTS"),

  // Trello backend (read when GENE_TRACKER=trello). Trello needs BOTH a key and a
  // token on every call. The daemon talks REST via the bundled trello/ wrapper; the
  // spawned agent uses the bundled trello CLI — both read these from the environment.
  TRELLO_API_KEY: optional("TRELLO_API_KEY"),
  TRELLO_TOKEN: optional("TRELLO_TOKEN"),
  // Trello OAuth secret (distinct from the user token) used to verify webhook
  // HMAC signatures. From trello.com/power-ups/admin under your API key.
  TRELLO_API_SECRET: optional("TRELLO_API_SECRET"),
  TRELLO_BOARD: optional("TRELLO_BOARD"),
  // Optional JSON map of state-name → list-id, overriding name-based list lookup
  // (use when the board's list names differ from the *_STATE values, or to pin ids).
  TRELLO_LIST_MAP: optional("TRELLO_LIST_MAP"),
  // Comment patterns that must NOT wake Gene up (see ignore.ts for the syntax).
  TRELLO_IGNORE_COMMENTS: optional("TRELLO_IGNORE_COMMENTS"),

  // Tracker semantics — namespaced by the active tracker (LINEAR_* / TRELLO_*).
  LABEL: str(`${TP}LABEL`, "Gene"),
  // Whom Gene works for: "me" (the authenticated tracker user), "any" (no assignee
  // filter), or a specific assignee (Linear: email; Trello: username). Issues not
  // assigned to this user are skipped.
  ASSIGNEE: str(`${TP}ASSIGNEE`, "me"),
  TRIGGER_STATE: str(`${TP}TRIGGER_STATE`, "Todo"),
  ACTIVE_STATE: str(`${TP}ACTIVE_STATE`, "In Progress"),
  BLOCKED_STATE: str(`${TP}BLOCKED_STATE`, "Blocked"),
  REVIEW_STATE: str(`${TP}REVIEW_STATE`, "In Review"),
  // Terminal state to auto-move an In-Review issue into once its change request
  // merges. Unset ⇒ disabled (merge→Done stays a manual human step). Tracker-
  // namespaced like the other *_STATE values. NOT in WATCHED_STATES — Done is
  // terminal and never scanned.
  DONE_STATE: optional(`${TP}DONE_STATE`),
  // Comma-separated list of plugin module paths and/or directories. Each module
  // default-exports a Plugin (see src/plugins/index.ts); a directory loads every
  // *.ts/*.js inside it. Plugins observe lifecycle events (ticket status change,
  // PR created, agent started/finished, pipeline complete). Unset ⇒ no plugins.
  PLUGINS: optional("GENE_PLUGINS"),
  AGENT_MARKER: term("GENE_AGENT_MARKER", "#gene-ai"),
  COMMAND_BASE: term("GENE_COMMAND_BASE", "!gene"),
  // Template for the branch Gene works on. Placeholders: {prefix}, {identifier},
  // {slug} (the issue title, slugified). {prefix} comes from the tracker when it
  // supplies one (Linear's suggested branch), else GENE_COMMAND_BASE stripped to
  // alphanumerics ("!gene" → "gene"). See branch.ts.
  BRANCH_TEMPLATE: str("GENE_BRANCH_TEMPLATE", "{prefix}/{identifier}-{slug}"),
  REQUIRE_SECTIONS: list("GENE_REQUIRE_SECTIONS"),
  GITLAB_HOST: str("GITLAB_HOST", ""),
  // Review-comment patterns that must NOT trigger a re-dispatch (see ignore.ts).
  // Unlike the tracker settings above these are NOT prefix-namespaced: the forge is
  // chosen per-issue, so both keys may be consulted in one run (ignore.ts picks by
  // forge name) — hence they're read directly rather than via the active TP prefix.
  GITLAB_IGNORE_COMMENTS: optional("GITLAB_IGNORE_COMMENTS"),
  GITHUB_IGNORE_COMMENTS: optional("GITHUB_IGNORE_COMMENTS"),
  REPO_MAP: optional("GENE_REPO_MAP"),
  REPO_URL: optional("GENE_REPO_URL"),

  REPOS_DIR: str("GENE_REPOS_DIR", "repos"),
  POLL_INTERVAL_MS: int("GENE_POLL_INTERVAL_MS", 60_000),
  DEBOUNCE_MS: int("GENE_DEBOUNCE_MS", 30_000),
  // Public callback URL Trello calls (e.g. a cloudflared tunnel pointing at the
  // local listener). Unset ⇒ webhook disabled, poll-only. Must be the EXACT URL
  // registered with Trello (it is part of the HMAC the signature is verified against).
  WEBHOOK_URL: optional("GENE_WEBHOOK_URL"),
  // Local port the webhook HTTP listener binds (your tunnel forwards here).
  WEBHOOK_PORT: int("GENE_WEBHOOK_PORT", 8473),
  MAX_CONCURRENT: Math.max(1, int("GENE_MAX_CONCURRENT", 2)),
  // Log-only preview: when true, no tracker/forge writes and no agent spawns. Defaults
  // to false — Gene acts for real; set GENE_DRY_RUN=true to preview safely.
  DRY_RUN: bool("GENE_DRY_RUN", false),
  // Open every change request as a draft; a human reviews, marks it ready, and
  // merges. When on, Gene never un-drafts a CR itself (its own or a human-attached
  // one) — the "ready" transition becomes a human gate. Forge-neutral (both forges).
  DRAFT_CHANGE_REQUEST: bool("GENE_DRAFT_CHANGE_REQUEST", false),
  CLAUDE_BIN: str("GENE_CLAUDE_BIN", "claude"),

  // A transient API/socket error mid-run makes `claude -p` exit non-zero. Retry the
  // spawn this many times (exponential backoff from AGENT_RETRY_DELAY_MS); the
  // worktree persists between attempts so a retry resumes prior work. 0 disables it.
  AGENT_MAX_RETRIES: int("GENE_AGENT_MAX_RETRIES", 5),
  AGENT_RETRY_DELAY_MS: int("GENE_AGENT_RETRY_DELAY_MS", 5_000),

  // Hard cap on a single agent run's active running time, in SECONDS (default
  // 1800 = 30 min). Counts foreground time only — time the host spends suspended
  // (laptop asleep) is not charged against it. When a run exceeds it the spawn is
  // killed (SIGTERM, then SIGKILL) and, if it still has retries left
  // (AGENT_MAX_RETRIES), restarted. 0 disables it.
  AGENT_MAX_PROCESSING_TIME: int("GENE_AGENT_MAX_PROCESSING_TIME", 1800),

  // Use Claude API-billing
  CLAUDE_API_BILLING: bool("GENE_CLAUDE_API_BILLING", false),

  // Run each spawned agent inside the microsandbox VM (sandbox/sandbox.sh run)
  // rather than directly on the host. Off by default; build the image first with
  // `sandbox/sandbox.sh base`. invoke.ts mounts the worktree and wires host auth in.
  SANDBOX: bool("GENE_SANDBOX", false),

  // Comma-separated list of additional tools to allow the agent to use.
  ALLOWED_TOOLS: list("GENE_ALLOWED_TOOLS"),
} as const;

// Trello needs a board to watch; fail fast with a friendly message rather than
// silently listing nothing later.
if (env.TRACKER === "trello" && !env.TRELLO_BOARD) {
  problems.push("TRELLO_BOARD: required when GENE_TRACKER=trello (the board id whose cards Gene watches)");
}

if (problems.length > 0) {
  /* eslint-disable no-console */
  logger.error(`${logger.tag.config} invalid environment configuration:`);
  for (const problem of problems) {
    logger.error(`  - ${problem}`);
  }
  logger.error("\nSet values in the environment, .env.development (dev), or gene.config (standalone). See .env.example.");
  /* eslint-enable no-console */
  process.exit(1);
}

/** Repo root = this project (the orchestrator). */
export const REPO_ROOT = process.cwd();

/** Pipeline runtime state (locks, etc.) — gitignored. The persistent state store
 * lives in Postgres now (see db.ts), not on disk here. */
export const GENE_DIR = path.join(REPO_ROOT, ".gene");
export const LOCK_DIR = path.join(GENE_DIR, "locks");

/** Absolute directory under which target repos are cloned and kept. */
export const REPOS_ROOT = path.isAbsolute(env.REPOS_DIR)
  ? env.REPOS_DIR
  : path.join(REPO_ROOT, env.REPOS_DIR);

/** Per-repo worktrees live here (one subdir per repo, then per issue id). */
export const WORKTREES_ROOT = path.join(REPOS_ROOT, ".worktrees");

/** States the daemon scans each cycle (active/blocked/review drained before trigger). */
export const WATCHED_STATES = {
  trigger: env.TRIGGER_STATE,
  active: env.ACTIVE_STATE,
  blocked: env.BLOCKED_STATE,
  review: env.REVIEW_STATE
} as const;
