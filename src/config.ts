/**
 * Environment + constants for the Gene pipeline. Hand-rolled (no zod) to keep
 * runtime dependencies minimal — PGlite (embedded Postgres for state, see db.ts)
 * is the only one — and let Node execute the TypeScript directly. Invalid values
 * collect into a list and exit(1) with a friendly message rather than throwing
 * deep in a module.
 *
 * Values are read from the process environment, which `node --env-file-if-exists`
 * has already populated from `.env.development`.
 */

import path from "node:path";

const problems: string[] = [];

const str = (key: string, fallback: string): string => {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
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

export const env = {
  LINEAR_API_KEY: optional("LINEAR_API_KEY"),
  LINEAR_WORKSPACE: optional("GENE_LINEAR_WORKSPACE"),

  GENE_LABEL: str("GENE_LABEL", "Gene"),
  TRIGGER_STATE: str("GENE_TRIGGER_STATE", "Todo"),
  ACTIVE_STATE: str("GENE_ACTIVE_STATE", "In Progress"),
  BLOCKED_STATE: str("GENE_BLOCKED_STATE", "Blocked"),
  REVIEW_STATE: str("GENE_REVIEW_STATE", "In Review"),
  AGENT_MARKER: str("GENE_AGENT_MARKER", "#gene-ai"),
  REQUIRE_SECTIONS: list("GENE_REQUIRE_SECTIONS"),

  GITLAB_HOST: str("GITLAB_HOST", "gitlab.datacrunch.io"),
  REPO_MAP: optional("GENE_REPO_MAP"),

  REPOS_DIR: str("GENE_REPOS_DIR", "repos"),
  POLL_INTERVAL_MS: int("GENE_POLL_INTERVAL_MS", 60_000),
  DEBOUNCE_MS: int("GENE_DEBOUNCE_MS", 30_000),
  MAX_CONCURRENT: Math.max(1, int("GENE_MAX_CONCURRENT", 2)),
  DRY_RUN: bool("GENE_DRY_RUN", true),
  CLAUDE_BIN: str("GENE_CLAUDE_BIN", "claude"),

  // A transient API/socket error mid-run makes `claude -p` exit non-zero. Retry the
  // spawn this many times (exponential backoff from AGENT_RETRY_DELAY_MS); the
  // worktree persists between attempts so a retry resumes prior work. 0 disables it.
  AGENT_MAX_RETRIES: int("GENE_AGENT_MAX_RETRIES", 2),
  AGENT_RETRY_DELAY_MS: int("GENE_AGENT_RETRY_DELAY_MS", 5_000)
} as const;

if (problems.length > 0) {
  /* eslint-disable no-console */
  console.error("[gene] invalid environment configuration:");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error("\nSet values in .env.development (gitignored). See .env.example.");
  /* eslint-enable no-console */
  process.exit(1);
}

/** Repo root = this project (the orchestrator). */
export const REPO_ROOT = process.cwd();

/** Pipeline runtime state (locks, etc.) — gitignored. */
export const GENE_DIR = path.join(REPO_ROOT, ".gene");
export const LOCK_DIR = path.join(GENE_DIR, "locks");

/** Embedded Postgres (PGlite) data directory — the daemon's persistent state. */
export const PGDATA_DIR = path.join(GENE_DIR, "pgdata");

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
