/**
 * Spawns `claude -p` for a single card iteration.
 *
 * - Worktree per card at `.ai-pipeline/worktrees/<shortLink>/`, branched off
 *   `origin/dev` (always fetched fresh so new worktrees start from the latest
 *   upstream tip — local `dev` may be stale).
 * - Captures stream-json stdout and renders one-line summaries to the daemon log.
 * - Applies the `ai:working` label on the card while the agent runs.
 */

import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import path from "path";
import readline from "readline";
import logger from "@/lib/logger";
import { LABELS } from "./config";
import { addLabelToCard, removeLabelFromCard, type TrelloCard } from "./trello";

const REPO_ROOT = process.cwd();
const WORKTREE_BASE = path.join(REPO_ROOT, ".ai-pipeline", "worktrees");

const ALLOWED_TOOLS = [
  // Project tooling
  "Bash(git *)",
  "Bash(npm *)",
  "Bash(npx *)",
  "Bash(gh *)",
  "Bash(jq *)",
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
  "Glob",
  // Trello updates
  "mcp__trello__*"
];

export type InvokeInputs = {
  card: TrelloCard;
  prompt: string;
};

export type InvokeResult = { kind: "spawned"; worktreePath: string; exitCode: number };

export const worktreePathFor = (card: TrelloCard): string =>
  path.join(WORKTREE_BASE, card.shortLink);

/**
 * Always fetch the latest `origin/dev` so newly-created worktrees start from
 * the upstream tip (local `dev` may be hours/days behind once merged PRs land).
 * `git fetch` updates the shared `.git` directory, so all existing worktrees
 * see the refreshed `origin/dev` ref immediately.
 */
const fetchOriginDev = async (): Promise<void> => {
  await new Promise<void>(resolve => {
    const proc = spawn("git", ["fetch", "origin", "dev"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "inherit"]
    });
    proc.on("exit", () => resolve());
    proc.on("error", () => resolve());
  });
};

/**
 * Count commits in `origin/dev` that are NOT in the worktree's current branch.
 * Returns 0 on git error or when up-to-date.
 */
export const commitsBehindOriginDev = (worktreePath: string): number => {
  const result = spawnSync("git", ["rev-list", "--count", "HEAD..origin/dev"], {
    cwd: worktreePath,
    encoding: "utf-8"
  });
  if (result.status !== 0) {
    return 0;
  }
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const ensureWorktree = async (card: TrelloCard): Promise<string> => {
  await fetchOriginDev();
  const target = worktreePathFor(card);
  if (existsSync(target)) {
    return target;
  }
  await mkdir(WORKTREE_BASE, { recursive: true });
  const branch = `fix/trello-${card.shortLink}-pipeline`;
  await new Promise<void>((resolve, reject) => {
    // Branch from origin/dev so the new worktree is up-to-date with merged PRs.
    const proc = spawn("git", ["worktree", "add", "-B", branch, target, "origin/dev"], {
      cwd: REPO_ROOT,
      stdio: "inherit"
    });
    proc.on("exit", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git worktree add exited ${code}`));
      }
    });
  });
  return target;
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

const renderEvent = (cardShortLink: string, event: StreamEvent): void => {
  const prefix = `[ai-pipeline] [${cardShortLink}]`;
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
      } else if (block.type === "thinking") {
        // skip — too verbose
      }
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

export const invokeAgent = async (inputs: InvokeInputs): Promise<InvokeResult> => {
  const { card, prompt } = inputs;
  const realWorktreePath = await ensureWorktree(card);
  logger.info(`[ai-pipeline] [${card.shortLink}] spawning agent in ${realWorktreePath}`);
  logger.info(`[ai-pipeline] [${card.shortLink}]   prompt: ${prompt.length} chars`);

  // Clean transition: remove ai:blocked (if present) and apply ai:working so the
  // card never shows both states simultaneously. The agent's prompt is responsible
  // for re-applying ai:blocked (or applying ai:done) before exiting.
  try {
    await removeLabelFromCard(card.id, LABELS.AI_BLOCKED);
  } catch (error) {
    logger.warn(
      `[ai-pipeline] [${card.shortLink}] could not remove ai:blocked label:`,
      error instanceof Error ? error.message : error
    );
  }
  try {
    await addLabelToCard(card.id, LABELS.AI_WORKING);
  } catch (error) {
    logger.warn(
      `[ai-pipeline] [${card.shortLink}] could not add ai:working label:`,
      error instanceof Error ? error.message : error
    );
  }

  let exitCode: number;
  // Strip ANTHROPIC_API_KEY so `claude -p` falls through to OAuth (Max plan)
  // instead of billing the API-key account. Other env vars (TRELLO_*, etc.)
  // are still inherited.
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;

  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      const proc = spawn(
        "claude",
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
          ...ALLOWED_TOOLS
        ],
        {
          cwd: realWorktreePath,
          stdio: ["ignore", "pipe", "inherit"],
          env: childEnv
        }
      );
      const lines = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      lines.on("line", line => {
        if (!line.trim()) {
          return;
        }
        try {
          const event = JSON.parse(line) as StreamEvent;
          renderEvent(card.shortLink, event);
        } catch {
          logger.info(`[ai-pipeline] [${card.shortLink}] raw: ${truncate(line, 200)}`);
        }
      });
      proc.on("error", reject);
      proc.on("exit", code => resolve(code ?? -1));
    });
  } finally {
    try {
      await removeLabelFromCard(card.id, LABELS.AI_WORKING);
    } catch (error) {
      logger.warn(
        `[ai-pipeline] [${card.shortLink}] could not remove ai:working label:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return { kind: "spawned", worktreePath: realWorktreePath, exitCode };
};
