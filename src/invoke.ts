/**
 * Spawns `claude -p` for a single issue iteration.
 *
 * - Worktree per issue at `<repos>/.worktrees/<repoPath>/<IDENTIFIER>`. The target
 *   repo is cloned on demand (then fetched) before the worktree is branched off
 *   `origin/<baseBranch>`, so new worktrees start from the latest upstream tip.
 *   The branch is the issue's `branchName` (on Linear that auto-links the MR).
 * - Captures stream-json stdout and renders one-line summaries to the daemon log.
 * - If GENE_CLAUDE_API_BILLING is true, passes the ANTHROPIC_API_KEY to the agent's environment
 *   environment to enable API-billing.
 * - Honours GENE_DRY_RUN: logs the would-be spawn instead of running the agent
 *   (the agent makes real tracker/forge writes, so it must never run in dry-run).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import logger from "./logger.ts";
import { monitor, type AgentEvent, type TokenUsage } from "./monitor.ts";
import { env, REPO_ROOT, REPOS_ROOT, WORKTREES_ROOT } from "./config.ts";
import { addWorktree, fetch } from "./git.ts";
import { logEvent } from "./db.ts";
import { setActiveTimeout, type ActiveTimeout } from "./timer.ts";
import { localPathFor, type RepoTarget } from "./repos.ts";
import { tracker } from "./tracker/index.ts";
import type { Issue } from "./tracker/index.ts";
import type { Forge } from "./forge/index.ts";
import { isRetriable, matchesTransient } from "./agent-retry.ts";
import chalk from "chalk";

/**
 * Tools the agent is permitted regardless of tracker/forge. The active tracker and
 * forge each add their own CLI on top (e.g. `Bash(linear *)` / `Bash(node *)` and
 * `Bash(glab *)` / `Bash(gh *)`) — none of those is baked in here.
 */
const BASE_ALLOWED_TOOLS = [
  // Project tooling
  "Bash(git *)",
  "Bash(npm *)",
  "Bash(yarn *)",
  "Bash(pnpm *)",
  "Bash(npx *)",
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
  "Bash(base64 *)",
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
  issue: Issue;
  prompt: string;
  worktreePath: string;
  forge: Forge;
};

export type InvokeResult = {
  kind: "spawned" | "dry-run";
  worktreePath: string;
  exitCode: number;
  /** True when a terminal `result`/`success` event was seen — a clean finish. */
  sawSuccessResult: boolean;
  /** True when the agent's stream showed a transient API/transport drop. */
  transientFailure: boolean;
  /** First transient error text seen (truncated), for the surfaced comment. */
  transientReason: string | null;
};

/** Absolute worktree path for an issue: `<repos>/.worktrees/<repoPath>/<IDENTIFIER>`. */
export const worktreePathFor = (target: RepoTarget, issue: Issue): string =>
  path.join(WORKTREES_ROOT, target.repoPath, issue.identifier);

/**
 * Where an existing change request lives, when continuing one rather than
 * starting fresh: its own source branch (checked out at the remote head) and the
 * target branch it merges into (used as the base for drift).
 */
export type ExistingChangeRequest = { branch: string; baseBranch: string };

/**
 * Ensure a worktree exists for this issue. Clones the target repo on demand (and
 * fetches it), then either:
 *  - **fresh** (default): branches the worktree off `origin/<base>` as the issue's
 *    `branchName` (on Linear that auto-links a new change request); or
 *  - **continue** (`existing` given): checks out the change request's *own* source
 *    branch at its remote head — the MR/PR may not be on the issue's branch.
 * Reuses an existing worktree (idempotent across resumes). Returns the worktree
 * path, the resolved base branch, and the branch actually checked out.
 */
export const ensureWorktree = async (
  target: RepoTarget,
  issue: Issue,
  forge: Forge,
  existing?: ExistingChangeRequest
): Promise<{ worktreePath: string; baseBranch: string; workBranch: string }> => {
  const localPath = localPathFor(target);
  // Clone-on-demand keeps arbitrary per-issue repos warm without a static list;
  // ensureClone also fetches an existing clone so worktrees see the latest tip.
  await forge.ensureClone(target, localPath);
  const baseBranch = existing?.baseBranch ?? target.ref ?? (await forge.detectDefaultBranch(localPath));
  const workBranch = existing?.branch ?? issue.branchName;
  const worktreePath = worktreePathFor(target, issue);
  if (!existsSync(worktreePath)) {
    await mkdir(path.dirname(worktreePath), { recursive: true });
    if (existing) {
      // Continue an existing change request: check out its branch at the remote
      // head (fetch it first — it may differ from the issue's own branch).
      await fetch(localPath, workBranch);
      await addWorktree(localPath, worktreePath, workBranch, workBranch);
    } else {
      await addWorktree(localPath, worktreePath, workBranch, baseBranch);
    }
  }
  return { worktreePath, baseBranch, workBranch };
};

const DEFAULT_TRUNCATE_MAX = 220;
const TOOL_ARG_MAX = 200;

const truncate = (value: string, max = DEFAULT_TRUNCATE_MAX): string => {
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

/** Token usage block, as emitted on assistant `message.usage` and the `result` event. */
type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type StreamEvent = {
  type?: string;
  subtype?: string;
  message?: { content?: ContentBlock[]; usage?: Usage };
  usage?: Usage;
  duration_ms?: number;
  result?: string;
  is_error?: boolean;
};

// AgentEvent — the distilled, JSON-serialisable view of one stream event — now
// lives in monitor.ts (the model layer) so the daemon, the activity log, and the
// TUI all share one shape. `toAgentEvents` below remains the single source of
// truth for WHICH events matter: renderEvent logs them, and runClaudeOnce both
// collects them for the activity log's `data` column and mirrors them to the
// monitor for the live dashboard.

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

/**
 * Distil one raw stream event into the records worth keeping — the single place
 * that decides what matters. renderEvent logs these and runClaudeOnce persists
 * them. Returns [] for events we ignore (thinking, partial messages), so both
 * consumers skip them uniformly.
 */
const toAgentEvents = (event: StreamEvent): AgentEvent[] => {
  if (event.type === "system" && event.subtype === "init") {
    return [{ type: "session" }];
  }
  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    const out: AgentEvent[] = [];
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        out.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        out.push({ type: "tool_use", tool: block.name ?? "Tool", summary: summarizeToolUse(block) });
      }
      // thinking blocks are skipped — too verbose for the daemon log
    }
    return out;
  }
  if (event.type === "user" && Array.isArray(event.message?.content)) {
    const out: AgentEvent[] = [];
    for (const block of event.message.content) {
      if (block.type === "tool_result" && block.is_error) {
        const detail =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        out.push({ type: "tool_error", detail });
      }
    }
    return out;
  }
  if (event.type === "result") {
    return [{ type: "result", subtype: event.subtype ?? "error", durationMs: event.duration_ms, result: event.result }];
  }
  return [];
};

/** Log the distilled records for one stream event as one-line daemon summaries. */
const renderEvent = (issueId: string, events: AgentEvent[]): void => {
  const prefix = `${logger.tag.invoke} [${chalk.blueBright(issueId)}]`;
  for (const event of events) {
    switch (event.type) {
      case "session":
        logger.info(`${prefix} ▶ session started`);
        break;
      case "text":
        logger.info(`${prefix} → ${truncate(event.text)}`);
        break;
      case "tool_use":
        logger.info(`${prefix} ↳ ${event.summary}`);
        break;
      case "tool_error":
        logger.warn(`${prefix} ⚠ ${truncate(event.detail)}`);
        break;
      case "result": {
        const seconds = event.durationMs ? (event.durationMs / 1000).toFixed(1) : "?";
        if (event.subtype === "success") {
          logger.info(`${prefix} ✓ done in ${seconds}s`);
        } else {
          logger.error(`${prefix} ✗ ${event.subtype} in ${seconds}s: ${truncate(event.result ?? "")}`);
        }
        break;
      }
    }
  }
};

/**
 * Distil a raw usage block into the monitor's {@link TokenUsage}, folding cache
 * reads/writes into the input total. Returns undefined for an absent or all-zero
 * block so callers can skip publishing — token capture is strictly best-effort.
 */
const toTokenUsage = (usage?: Usage): TokenUsage | undefined => {
  if (!usage) {
    return undefined;
  }
  const cached = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const input = (usage.input_tokens ?? 0) + cached;
  const output = usage.output_tokens ?? 0;
  if (input === 0 && output === 0) {
    return undefined;
  }
  return { in: input, out: output, total: input + output };
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Grace between SIGTERM and SIGKILL when a run overruns GENE_AGENT_MAX_PROCESSING_TIME. */
const KILL_GRACE_MS = 10_000;

/** Path to the microsandbox driver (used only when GENE_SANDBOX is set). */
const SANDBOX_SCRIPT = path.join(REPO_ROOT, "sandbox", "sandbox.sh");

/** The `claude -p` CLI args — identical whether we spawn it directly or sandboxed. */
const getAgentArgs = (prompt: string, allowedTools: string[]): string[] => [
  "-p",
  prompt,
  "--permission-mode",
  "acceptEdits",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--allowedTools",
  ...allowedTools,
  "--add-dir",
  "/tmp",
  // Add /private/tmp if it exists and we're not sandboxed (i.e. on MacOS)
  ...(!env.SANDBOX && existsSync("/private/tmp") ?
    ["--add-dir", "/private/tmp"] : [])
];

/**
 * How to launch one agent run. Directly that's `claude -p …` in the worktree.
 * With GENE_SANDBOX it's the same command, run inside a microsandbox VM via
 * sandbox/sandbox.sh:
 *
 *   sandbox.sh run --inherit -v <REPOS_ROOT>:<REPOS_ROOT> -w <worktree> -- claude -p …
 *
 * We bind-mount the repos root at its *host path* (not via `--dir`, which remaps
 * it to /workspace/<name>): a git worktree's `.git` is an absolute-path link into
 * its parent clone, so only same-path mounting keeps git — and therefore gh/glab —
 * working inside the VM. `-w <worktree>` lands the agent in that dir (and, under
 * --inherit, pre-trusts it for claude). `--inherit` carries the host's
 * claude/gh/glab/linear/trello auth into the otherwise-isolated VM (and implies
 * --internal, so on-prem forges over Tailscale stay reachable). All GENE_SANDBOX_*
 * knobs flow through from the daemon's environment.
 */
const getSpawnCommand = (
  worktreePath: string,
  prompt: string,
  allowedTools: string[]
): { command: string; args: string[] } => {
  const agent = getAgentArgs(prompt, allowedTools);

  if (!env.SANDBOX) {
    return { command: env.CLAUDE_BIN, args: agent };
  }

  return {
    command: SANDBOX_SCRIPT,
    args: [
      "run",
      "--inherit",
      "-v",
      `${REPOS_ROOT}:${REPOS_ROOT}`,
      "-w",
      worktreePath,
      "--",
      env.CLAUDE_BIN,
      ...agent
    ]
  };
};

/** One `claude -p` run. Resolves with the exit code + the result event's subtype. */
const runClaudeOnce = (
  issue: Issue,
  prompt: string,
  worktreePath: string,
  allowedTools: string[],
  childEnv: NodeJS.ProcessEnv,
  updatePid?: (pid: number) => void
): Promise<{
  exitCode: number;
  resultSubtype: string | undefined;
  resultText: string | undefined;
  durationMs: number | undefined;
  timedOut: boolean;
  transientFailure: boolean;
  transientReason: string | null;
  events: AgentEvent[];
}> =>
  new Promise((resolve, reject) => {
    let resultSubtype: string | undefined;
    let resultText: string | undefined;
    let durationMs: number | undefined;
    let timedOut = false;
    let transientFailure = false;
    let transientReason: string | null = null;
    const events: AgentEvent[] = [];
    const { command, args } = getSpawnCommand(worktreePath, prompt, allowedTools);
    // In sandbox mode the child (sandbox.sh) spawns msb + the VM beneath it, so
    // detach it into its own process group — a timeout can then tear down the whole
    // subtree via the negative pid, not just the wrapper. Direct runs are a single
    // process and stay in our group (so a terminal Ctrl-C still reaches them).
    const proc = spawn(command, args, {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "inherit"],
      env: childEnv,
      detached: env.SANDBOX
    });

    if (updatePid && proc.pid) {
      updatePid(proc.pid);
    }

    // Wall-clock cap (GENE_AGENT_MAX_PROCESSING_TIME seconds, 0 = off): SIGTERM the
    // run, then SIGKILL if it lingers past KILL_GRACE_MS. The non-zero exit that
    // follows is treated as retriable by the caller, so the run may be restarted.
    const signalChild = (sig: NodeJS.Signals): void => {
      try {
        if (env.SANDBOX && proc.pid) {
          process.kill(-proc.pid, sig); // negative pid → the detached process group
        } else {
          proc.kill(sig);
        }
      } catch {
        // already exited — nothing to signal
      }
    };
    // Mirror the spawn into the monitor so the TUI can show the pid and offer a
    // cancel that maps to exactly the same teardown the timeout uses (SIGTERM,
    // process-group-aware under sandbox). Re-registers on each retry attempt, so a
    // cancel always targets the currently-live child.
    if (proc.pid) {
      monitor.agentSpawned(issue.identifier, proc.pid, () => signalChild("SIGTERM"));
    }
    // Budget counts active time only: setActiveTimeout pauses while the host is
    // suspended (laptop asleep), so a run isn't killed for time it spent frozen.
    let killTimer: ActiveTimeout | undefined;
    let hardKillTimer: NodeJS.Timeout | undefined;
    if (env.AGENT_MAX_PROCESSING_TIME > 0) {
      killTimer = setActiveTimeout(() => {
        timedOut = true;
        logger.warn(
          `${logger.tag.invoke} [${issue.identifier}] exceeded GENE_AGENT_MAX_PROCESSING_TIME ` +
          `(${env.AGENT_MAX_PROCESSING_TIME}s active) — terminating (pid ${proc.pid})`
        );
        signalChild("SIGTERM");
        hardKillTimer = setTimeout(() => {
          logger.warn(`${logger.tag.invoke} [${issue.identifier}] still alive after SIGTERM — sending SIGKILL`);
          signalChild("SIGKILL");
        }, KILL_GRACE_MS);
      }, env.AGENT_MAX_PROCESSING_TIME * 1000);
    }
    const clearTimers = (): void => {
      killTimer?.cancel();
      if (hardKillTimer) {
        clearTimeout(hardKillTimer);
      }
    };

    const lines = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    lines.on("line", line => {
      if (!line.trim()) {
        return;
      }
      try {
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === "result") {
          resultSubtype = event.subtype;
          resultText = event.result;
          durationMs = event.duration_ms;
        }
        // A dropped API socket surfaces as assistant text but still exits 0 — flag
        // it so the run is retried/surfaced rather than recorded as a clean finish.
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === "text" && typeof block.text === "string" && matchesTransient(block.text)) {
              transientFailure = true;
              transientReason ??= block.text.slice(0, 300);
              logger.warn(`${logger.tag.invoke} [${issue.identifier}] transient API error in stream: ${truncate(block.text)}`);
            }
          }
        }
        const records = toAgentEvents(event);
        events.push(...records);
        renderEvent(issue.identifier, records);
        for (const record of records) {
          monitor.agentEvent(issue.identifier, record);
        }
        // Best-effort token capture: assistant turns carry a running `message.usage`,
        // the final `result` event carries the authoritative cumulative `usage`.
        const usage = toTokenUsage(event.usage ?? event.message?.usage);
        if (usage) {
          monitor.agentTokens(issue.identifier, usage);
        }
      } catch {
        logger.info(`${logger.tag.invoke} [${issue.identifier}] raw: ${truncate(line, 200)}`);
      }
    });

    // A spawn `error` (e.g. the claude binary is missing) is not transient — let it
    // reject so the caller surfaces it rather than retrying a doomed command.
    proc.on("error", error => {
      clearTimers();
      reject(error);
    });

    proc.on("exit", code => {
      clearTimers();
      resolve({
        exitCode: code ?? -1,
        resultSubtype,
        resultText,
        durationMs,
        timedOut,
        transientFailure,
        transientReason,
        events
      });
    });
  });

export const invokeAgent = async (
  inputs: InvokeInputs,
  updatePid?: (pid: number) => void
): Promise<InvokeResult> => {
  const { issue, prompt, worktreePath, forge } = inputs;
  const id = issue.identifier;
  const allowedTools = [...BASE_ALLOWED_TOOLS, ...tracker.allowedTools(), ...forge.allowedTools()];
  allowedTools.push(...env.ALLOWED_TOOLS);

  const agentLabel = env.SANDBOX ? `sandboxed ${env.CLAUDE_BIN}` : env.CLAUDE_BIN;

  if (env.DRY_RUN) {
    logger.info(
      `${logger.tag.invoke} [${id}] (dry-run) would spawn ${agentLabel} in ${worktreePath} ` +
      `(prompt ${prompt.length} chars, ${allowedTools.length} tools)`
    );
    return { kind: "dry-run", worktreePath, exitCode: 0, sawSuccessResult: true, transientFailure: false, transientReason: null };
  }

  // If GENE_CLAUDE_API_BILLING is true, passes the ANTHROPIC_API_KEY to the agent's environment
  // than billing the API-key account. The tracker's credentials (LINEAR_API_KEY /
  // TRELLO_API_KEY + TRELLO_TOKEN) and the rest are inherited.
  const childEnv = { ...process.env };
  if (!env.CLAUDE_API_BILLING) {
    delete childEnv.ANTHROPIC_API_KEY;
  }

  const recordAgent = (event: string, detail: string, data?: unknown): Promise<void> =>
    logEvent({ tracker: tracker.name, identifier: id, event, detail, data });

  const totalAttempts = env.AGENT_MAX_RETRIES + 1;
  let exitCode = -1;
  let resultSubtype: string | undefined;
  let resultText: string | undefined;
  let durationMs: number | undefined;
  let timedOut = false;
  let transientFailure = false;
  let transientReason: string | null = null;
  let attemptsMade = 0;
  let events: AgentEvent[] = [];

  await recordAgent(
    "agent-start",
    `dispatching ${agentLabel} in ${worktreePath}` +
    (totalAttempts > 1 ? ` (up to ${totalAttempts} attempts)` : "")
  );

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    attemptsMade = attempt;
    const suffix = totalAttempts > 1 ? ` (attempt ${attempt}/${totalAttempts})` : "";
    logger.info(`${logger.tag.invoke} [${id}] spawning agent in ${worktreePath}${suffix}`);
    logger.info(`${logger.tag.invoke} [${id}]   prompt: ${prompt.length} chars`);

    ({ exitCode, resultSubtype, resultText, durationMs, timedOut, transientFailure, transientReason, events } =
      await runClaudeOnce(issue, prompt, worktreePath, allowedTools, childEnv, updatePid));

    // Operator cancelled this run from the TUI: the child was already signalled, so
    // the non-zero exit it produced must NOT be retried (isRetriable would treat it
    // as a transient crash and spawn again). Stop here; the final recording marks it
    // cancelled rather than letting the retry loop fight the kill.
    if (monitor.isCancelled(id)) {
      break;
    }

    if (timedOut) {
      await recordAgent(
        "agent-timeout",
        `killed after ${env.AGENT_MAX_PROCESSING_TIME}s (attempt ${attempt}/${totalAttempts})`
      );
    }

    // A timed-out run is always worth restarting — it was cut off mid-work, not
    // finished — so OR it in with the transient-failure heuristic for normal exits.
    if ((!timedOut && !isRetriable(exitCode, resultSubtype, transientFailure)) || attempt === totalAttempts) {
      break;
    }
    const delay = env.AGENT_RETRY_DELAY_MS * 2 ** (attempt - 1);
    const why = timedOut
      ? `timed out after ${env.AGENT_MAX_PROCESSING_TIME}s`
      : `exited ${exitCode}${resultSubtype ? ` (${resultSubtype})` : ""} — likely transient`;
    logger.warn(
      `${logger.tag.invoke} [${id}] agent ${why}; retrying in ${Math.round(delay / 1000)}s ` +
      `(attempt ${attempt + 1}/${totalAttempts})`
    );
    await sleep(delay);
  }

  // Record what the agent actually did — its own final summary is the best account.
  const seconds = durationMs ? (durationMs / 1000).toFixed(1) : "?";
  const summary = resultText ? ` — ${truncate(resultText, 2000)}` : "";
  const sawSuccessResult = resultSubtype === "success";
  // Exit 0 but the run never produced a success result (silent crash) or dropped
  // its API socket mid-stream (transient): not a clean finish.
  const stalled = exitCode === 0 && (transientFailure || !sawSuccessResult);
  if (monitor.isCancelled(id)) {
    // Cancelled from the TUI: the child was killed mid-run and deliberately not
    // retried. Record it as its own outcome so the log doesn't read like a crash.
    await recordAgent("agent-cancelled", `cancelled by operator after ${seconds}s${summary}`, events);
    monitor.agentFinished(id, "cancelled", durationMs);
  } else if (stalled) {
    await recordAgent(
      "agent-stalled",
      `ended without a clean result after ${seconds}s` +
        `${transientFailure ? " (transient API drop)" : " (no success result)"}${summary}`,
      events
    );
    monitor.agentFinished(id, "error", durationMs);
  } else if (exitCode === 0) {
    await recordAgent("agent-done", `completed in ${seconds}s${summary}`, events);
    monitor.agentFinished(id, "done", durationMs);
  } else {
    const triedNote = attemptsMade > 1 ? ` after ${attemptsMade} attempts` : "";
    const timeoutNote = timedOut ? ` (timed out at ${env.AGENT_MAX_PROCESSING_TIME}s)` : "";
    await recordAgent(
      "agent-error",
      `exited ${exitCode}${resultSubtype ? ` (${resultSubtype})` : ""}${timeoutNote}${triedNote}${summary}`,
      events
    );
    monitor.agentFinished(id, timedOut ? "timeout" : "error", durationMs);
  }

  if (exitCode !== 0) {
    const tried = attemptsMade > 1 ? ` after ${attemptsMade} attempts` : "";
    logger.error(
      `${logger.tag.invoke} [${id}] agent exited ${exitCode}${tried} — issue left in "${env.ACTIVE_STATE}"; ` +
      `inspect, then re-trigger or \`npm run reset -- ${id}\``
    );
  }
  return { kind: "spawned", worktreePath, exitCode, sawSuccessResult, transientFailure, transientReason };
};
