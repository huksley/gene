/**
 * Spawns `claude -p` for a single issue iteration.
 *
 * - Worktree per issue at `<repos>/.worktrees/<repoPath>/<IDENTIFIER>`. The target
 *   repo is cloned on demand (then fetched) before the worktree is branched off
 *   `origin/<baseBranch>`, so new worktrees start from the latest upstream tip.
 *   The branch is Linear's `branchName`, so the change request auto-links.
 * - Captures stream-json stdout and renders one-line summaries to the daemon log.
 * - Strips ANTHROPIC_API_KEY from the child env so `claude` uses OAuth (Max plan)
 *   rather than billing an API key.
 * - Honours GENE_DRY_RUN: logs the would-be spawn instead of running the agent
 *   (the agent makes real Linear/forge writes, so it must never run in dry-run).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import logger from "./logger.ts";
import { env, WORKTREES_ROOT } from "./config.ts";
import { addWorktree } from "./git.ts";
import { localPathFor, type RepoTarget } from "./repos.ts";
import type { LinearIssue } from "./linear.ts";
import type { Forge } from "./forge/index.ts";

/**
 * Tools the agent is permitted regardless of forge. The active forge adds its own
 * CLI on top (e.g. `Bash(glab *)` or `Bash(gh *)`) — none is baked in here.
 */
const BASE_ALLOWED_TOOLS = [
  // Project tooling
  "Bash(git *)",
  "Bash(npm *)",
  "Bash(npx *)",
  "Bash(jq *)",
  // Linear write-back (comments + state moves)
  "Bash(linear *)",
  // Read-only discovery + text manipulation
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(rg *)",
  "Bash(grep *)",
  "Bash(find *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(echo *)",
  "Bash(sed *)",
  "Bash(awk *)",
  "Bash(sort *)",
  "Bash(uniq *)",
  "Bash(wc *)",
  "Bash(diff *)",
  "Bash(which *)",
  "Bash(env *)",
  "Bash(true *)",
  "Bash(false *)",
  "Bash(test *)",
  // Light filesystem operations (worktree-scoped via cwd)
  "Bash(mkdir *)",
  "Bash(mv *)",
  "Bash(cp *)",
  "Bash(touch *)",
  // Direct file editing
  "Edit",
  "Read",
  "Write",
  // Search
  "Grep",
  "Glob"
];

export type InvokeInputs = {
  issue: LinearIssue;
  prompt: string;
  worktreePath: string;
  forge: Forge;
};

export type InvokeResult = { kind: "spawned" | "dry-run"; worktreePath: string; exitCode: number };

/** Absolute worktree path for an issue: `<repos>/.worktrees/<repoPath>/<IDENTIFIER>`. */
export const worktreePathFor = (target: RepoTarget, issue: LinearIssue): string =>
  path.join(WORKTREES_ROOT, target.repoPath, issue.identifier);

/**
 * Ensure a worktree exists for this issue. Clones the target repo on demand (and
 * fetches it), resolves the base branch (the ref pinned by a /tree/ link, else
 * the clone's default branch), then branches the worktree off `origin/<base>`.
 * Reuses an existing worktree (idempotent across resumes). Returns the worktree
 * path and the resolved base branch.
 */
export const ensureWorktree = async (
  target: RepoTarget,
  issue: LinearIssue,
  forge: Forge
): Promise<{ worktreePath: string; baseBranch: string }> => {
  const localPath = localPathFor(target);
  // Clone-on-demand keeps arbitrary per-issue repos warm without a static list;
  // ensureClone also fetches an existing clone so worktrees see the latest tip.
  await forge.ensureClone(target, localPath);
  const baseBranch = target.ref ?? (await forge.detectDefaultBranch(localPath));
  const worktreePath = worktreePathFor(target, issue);
  if (!existsSync(worktreePath)) {
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await addWorktree(localPath, worktreePath, issue.branchName, baseBranch);
  }
  return { worktreePath, baseBranch };
};

const TEXT_MAX = 220;
const TOOL_ARG_MAX = 200;

const truncate = (value: string, max = TEXT_MAX): string => {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
};

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
};

type StreamEvent = {
  type?: string;
  subtype?: string;
  message?: { content?: ContentBlock[] };
  duration_ms?: number;
  result?: string;
  is_error?: boolean;
};

const summarizeToolUse = (block: ContentBlock): string => {
  const name = block.name ?? "Tool";
  const input = block.input ?? {};
  const keyArg =
    (input as { file_path?: string }).file_path ??
    (input as { path?: string }).path ??
    (input as { command?: string }).command ??
    (input as { pattern?: string }).pattern ??
    (input as { url?: string }).url ??
    (input as { description?: string }).description ??
    (input as { prompt?: string }).prompt ??
    (input as { query?: string }).query ??
    "";
  return keyArg ? `${name}(${truncate(String(keyArg), TOOL_ARG_MAX)})` : name;
};

const renderEvent = (issueId: string, event: StreamEvent): void => {
  const prefix = `[gene] [${issueId}]`;
  if (event.type === "system" && event.subtype === "init") {
    logger.info(`${prefix} ▶ session started`);
    return;
  }
  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        logger.info(`${prefix} 💬 ${truncate(block.text)}`);
      } else if (block.type === "tool_use") {
        logger.info(`${prefix} 🛠 ${summarizeToolUse(block)}`);
      }
      // thinking blocks are skipped — too verbose for the daemon log
    }
    return;
  }
  if (event.type === "user" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block.type === "tool_result" && block.is_error) {
        const text =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        logger.warn(`${prefix} ⚠ tool error: ${truncate(text)}`);
      }
    }
    return;
  }
  if (event.type === "result") {
    const seconds = event.duration_ms ? (event.duration_ms / 1000).toFixed(1) : "?";
    if (event.subtype === "success") {
      logger.info(`${prefix} ✅ done in ${seconds}s`);
    } else {
      logger.error(
        `${prefix} ❌ ${event.subtype ?? "error"} in ${seconds}s: ${truncate(event.result ?? "")}`
      );
    }
  }
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Should we retry a spawn that just ended this way? A non-zero exit is almost
 * always a crash or a transient API/socket error — `claude -p` exits 0 even when
 * it deliberately blocks or gives up on a task, so a non-zero code signals the run
 * itself broke. The one non-zero case not worth retrying is hitting the turn limit;
 * re-running would just burn the same budget. The worktree persists between
 * attempts, so a retry resumes from whatever the previous attempt already wrote.
 */
const isRetriable = (exitCode: number, resultSubtype: string | undefined): boolean =>
  exitCode !== 0 && resultSubtype !== "error_max_turns";

/** One `claude -p` run. Resolves with the exit code + the result event's subtype. */
const runClaudeOnce = (
  issue: LinearIssue,
  prompt: string,
  worktreePath: string,
  allowedTools: string[],
  childEnv: NodeJS.ProcessEnv
): Promise<{ exitCode: number; resultSubtype: string | undefined }> =>
  new Promise((resolve, reject) => {
    let resultSubtype: string | undefined;
    const proc = spawn(
      env.CLAUDE_BIN,
      [
        "-p",
        prompt,
        "--permission-mode",
        "acceptEdits",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--allowedTools",
        ...allowedTools
      ],
      {
        cwd: worktreePath,
        stdio: ["ignore", "pipe", "inherit"],
        env: childEnv
      }
    );
    const lines = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    lines.on("line", line => {
      if (!line.trim()) {
        return;
      }
      try {
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === "result") {
          resultSubtype = event.subtype;
        }
        renderEvent(issue.identifier, event);
      } catch {
        logger.info(`[gene] [${issue.identifier}] raw: ${truncate(line, 200)}`);
      }
    });
    // A spawn `error` (e.g. the claude binary is missing) is not transient — let it
    // reject so the caller surfaces it rather than retrying a doomed command.
    proc.on("error", reject);
    proc.on("exit", code => resolve({ exitCode: code ?? -1, resultSubtype }));
  });

export const invokeAgent = async (inputs: InvokeInputs): Promise<InvokeResult> => {
  const { issue, prompt, worktreePath, forge } = inputs;
  const id = issue.identifier;
  const allowedTools = [...BASE_ALLOWED_TOOLS, ...forge.allowedTools()];

  if (env.DRY_RUN) {
    logger.info(
      `[gene] [${id}] (dry-run) would spawn ${env.CLAUDE_BIN} in ${worktreePath} ` +
        `(prompt ${prompt.length} chars, ${allowedTools.length} tools)`
    );
    return { kind: "dry-run", worktreePath, exitCode: 0 };
  }

  // Strip ANTHROPIC_API_KEY so `claude` falls through to OAuth (Max plan) rather
  // than billing the API-key account. LINEAR_API_KEY and the rest are inherited.
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;

  const totalAttempts = env.AGENT_MAX_RETRIES + 1;
  let exitCode = -1;
  let resultSubtype: string | undefined;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    attemptsMade = attempt;
    const suffix = totalAttempts > 1 ? ` (attempt ${attempt}/${totalAttempts})` : "";
    logger.info(`[gene] [${id}] spawning agent in ${worktreePath}${suffix}`);
    logger.info(`[gene] [${id}]   prompt: ${prompt.length} chars`);

    ({ exitCode, resultSubtype } = await runClaudeOnce(
      issue,
      prompt,
      worktreePath,
      allowedTools,
      childEnv
    ));

    if (!isRetriable(exitCode, resultSubtype) || attempt === totalAttempts) {
      break;
    }
    const delay = env.AGENT_RETRY_DELAY_MS * 2 ** (attempt - 1);
    logger.warn(
      `[gene] [${id}] agent exited ${exitCode}${resultSubtype ? ` (${resultSubtype})` : ""} — ` +
        `likely transient; retrying in ${Math.round(delay / 1000)}s ` +
        `(attempt ${attempt + 1}/${totalAttempts})`
    );
    await sleep(delay);
  }

  if (exitCode !== 0) {
    const tried = attemptsMade > 1 ? ` after ${attemptsMade} attempts` : "";
    logger.error(
      `[gene] [${id}] agent exited ${exitCode}${tried} — issue left in "${env.ACTIVE_STATE}"; ` +
        `inspect, then re-trigger or \`npm run reset -- ${id}\``
    );
  }
  return { kind: "spawned", worktreePath, exitCode };
};
