/**
 * Testing-lane orchestrator.
 *
 * Watches the "🧪 Testing on testing.welby.ch" Trello list and keeps the
 * welby-testing DollarDeploy app's source branch in sync with whatever PR
 * the active card points at. State persists in `.ai-pipeline/dd-state.json`
 * so deploy polling survives daemon restarts.
 *
 * One card at a time. If multiple cards land in the lane, the most recently
 * active wins; older ones are bumped back to the `Testing` list with a comment.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import logger from "@/lib/logger";
import { buildAndDeploy, getApp, getTask, getTaskLogs, setBranch } from "./dollardeploy";
import { DOLLARDEPLOY_TESTING_HOSTNAME, LISTS, env } from "./config";
import {
  getCardComments,
  getCardsInList,
  moveCard,
  postComment,
  type TrelloCard,
  type TrelloComment
} from "./trello";

const STATE_DIR = path.join(process.cwd(), ".ai-pipeline");
const STATE_FILE = path.join(STATE_DIR, "dd-state.json");

type DdState = {
  currentCardId: string | null;
  currentBranch: string | null;
  lastTaskId: string | null;
  lastTaskStatus: string | null;
  deployStartedAt: string | null;
};

const emptyState: DdState = {
  currentCardId: null,
  currentBranch: null,
  lastTaskId: null,
  lastTaskStatus: null,
  deployStartedAt: null
};

const readState = (): DdState => {
  if (!existsSync(STATE_FILE)) {
    return { ...emptyState };
  }
  try {
    return {
      ...emptyState,
      ...(JSON.parse(readFileSync(STATE_FILE, "utf-8")) as Partial<DdState>)
    };
  } catch {
    return { ...emptyState };
  }
};

const writeState = (state: DdState): void => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};

const PR_URL_REGEX = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/;

const findLatestPrUrl = (
  comments: TrelloComment[]
): { url: string; number: number } | null => {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const match = PR_URL_REGEX.exec(comments[i].data.text);
    if (match) {
      return { url: match[0], number: Number.parseInt(match[1], 10) };
    }
  }
  return null;
};

const resolveBranchFromPr = (prNumber: number): string | null => {
  const result = spawnSync(
    "gh",
    ["pr", "view", String(prNumber), "--json", "headRefName", "-q", ".headRefName"],
    {
      encoding: "utf-8"
    }
  );
  if (result.status !== 0) {
    logger.warn(`[deploy] gh pr view ${prNumber} failed: ${result.stderr.trim()}`);
    return null;
  }
  return result.stdout.trim() || null;
};

const bumpCardBack = async (card: TrelloCard, reason: string): Promise<void> => {
  try {
    await postComment(
      card.id,
      `🤖 ${reason}\n\nThis card was moved back to the \`Testing\` list — the testing lane only holds one card at a time. Move it back to deploy.`
    );
    await moveCard(card.id, LISTS.TESTING);
    logger.info(
      `[deploy] bumped [${card.shortLink}] "${card.name}" back to Testing — ${reason}`
    );
  } catch (error) {
    logger.error(
      `[deploy] failed to bump card ${card.shortLink}:`,
      error instanceof Error ? error.message : error
    );
  }
};

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "cancelled", "error"]);

const tailLogs = (logs: string, lines = 20): string => {
  const split = logs.split("\n");
  return split.slice(-lines).join("\n");
};

/**
 * Poll the in-flight deploy task once. If it's terminal, post a result comment
 * and clear the lastTaskId from state. Returns true if a terminal state was
 * just observed and reported.
 */
const pollInFlightDeploy = async (state: DdState): Promise<boolean> => {
  if (!state.lastTaskId || !state.currentCardId) {
    return false;
  }
  try {
    const task = await getTask(state.lastTaskId);
    if (state.lastTaskStatus !== task.status) {
      logger.info(
        `[deploy] task ${state.lastTaskId} status: ${state.lastTaskStatus} → ${task.status}`
      );
    }
    if (!TERMINAL_TASK_STATES.has(task.status)) {
      writeState({ ...state, lastTaskStatus: task.status });
      return false;
    }

    // DD chains build:app → deploy:app via nextTaskId. When the current task
    // completes successfully and has a next task, switch our pointer to it
    // and keep polling — only the final task in the chain is what the user
    // cares about ("did the deploy itself land?").
    if (task.status === "completed" && task.nextTaskId) {
      logger.info(
        `[deploy] task ${task.id} (${task.type}) completed — following chain to ${task.nextTaskId}`
      );
      writeState({
        ...state,
        lastTaskId: task.nextTaskId,
        lastTaskStatus: "pending"
      });
      return false;
    }

    const isSuccess = task.status === "completed";
    const elapsedMs = state.deployStartedAt
      ? Date.now() - new Date(state.deployStartedAt).getTime()
      : null;
    const elapsedNote = elapsedMs ? ` (${(elapsedMs / 1000).toFixed(0)}s)` : "";

    if (isSuccess) {
      await postComment(
        state.currentCardId,
        `🤖 ✅ Deployed branch \`${state.currentBranch}\` to \`${DOLLARDEPLOY_TESTING_HOSTNAME}\`${elapsedNote}.\n\n🔗 https://${DOLLARDEPLOY_TESTING_HOSTNAME}`
      );
      logger.info(
        `[deploy] ✅ deploy completed for [${state.currentCardId}] branch ${state.currentBranch}`
      );
    } else {
      let logTail = "(no logs)";
      try {
        const logs = await getTaskLogs(state.lastTaskId);
        if (logs.trim().length > 0) {
          logTail = "```\n" + tailLogs(logs) + "\n```";
        }
      } catch (error) {
        logger.warn(
          `[deploy] could not fetch task logs for ${state.lastTaskId}:`,
          error instanceof Error ? error.message : error
        );
      }
      await postComment(
        state.currentCardId,
        `🤖 ❌ Deploy of branch \`${state.currentBranch}\` to \`${DOLLARDEPLOY_TESTING_HOSTNAME}\` failed${elapsedNote}.\n\n**Task status:** \`${task.status}\`${task.error ? `\n**Error:** ${task.error}` : ""}\n\n**Last log lines:**\n${logTail}`
      );
      logger.warn(
        `[deploy] ❌ deploy failed for [${state.currentCardId}] branch ${state.currentBranch}: ${task.status}`
      );
    }
    writeState({
      ...state,
      lastTaskId: null,
      lastTaskStatus: task.status,
      deployStartedAt: null
    });
    return true;
  } catch (error) {
    logger.error(
      `[deploy] failed to poll task ${state.lastTaskId}:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
};

/**
 * Main entry for the testing lane. Called once per daemon scan cycle.
 */
export const processTestingLane = async (listId: string): Promise<void> => {
  if (!env.DOLLARDEPLOY_API_KEY) {
    return;
  }

  const cards = await getCardsInList(listId);
  let state = readState();

  // Poll any in-flight deploy first; if it terminated, refresh state.
  if (state.lastTaskId) {
    await pollInFlightDeploy(state);
    state = readState();
  }

  if (cards.length === 0) {
    if (state.currentCardId) {
      writeState({ ...emptyState });
    }
    return;
  }

  // Enforce one-card-at-a-time: pick most recently active, bump the rest.
  const sorted = [...cards].sort((a, b) =>
    b.dateLastActivity.localeCompare(a.dateLastActivity)
  );
  const active = sorted[0];
  const bumped = sorted.slice(1);
  for (const card of bumped) {
    await bumpCardBack(card, `Making room for "${active.name}" in the testing lane.`);
  }

  // Still mid-deploy on this same card? Nothing to do.
  if (state.lastTaskId && state.currentCardId === active.id) {
    logger.info(
      `[deploy] [${active.shortLink}] deploy already in flight (task ${state.lastTaskId})`
    );
    return;
  }

  // Find the branch to deploy.
  const comments = await getCardComments(active.id);
  const pr = findLatestPrUrl(comments);
  if (!pr) {
    if (state.currentCardId !== active.id) {
      await postComment(
        active.id,
        `🤖 I can't deploy this card yet — I couldn't find a PR link in the comments.\n\nMake sure a comment contains a URL like \`https://github.com/${"<owner>"}/${"<repo>"}/pull/<number>\` (the agent posts this automatically once it opens a PR), then re-trigger by moving the card out and back into the testing lane.`
      );
      writeState({ ...emptyState, currentCardId: active.id });
    }
    return;
  }

  const branch = resolveBranchFromPr(pr.number);
  if (!branch) {
    await postComment(
      active.id,
      `🤖 Found PR #${pr.number} but couldn't resolve its branch via \`gh pr view\`. Is the PR still open and accessible to the daemon's gh auth?`
    );
    return;
  }

  // Same card AND same branch as last deploy → nothing to do.
  if (
    state.currentCardId === active.id &&
    state.currentBranch === branch &&
    !state.lastTaskId
  ) {
    return;
  }

  // Compare to DD's actual current branch — avoid no-op redeploys.
  let ddCurrentBranch: string | null = null;
  try {
    const app = await getApp();
    ddCurrentBranch = app.sourceBranch;
  } catch (error) {
    logger.error(
      "[deploy] could not fetch current welby-testing app state:",
      error instanceof Error ? error.message : error
    );
    return;
  }

  if (ddCurrentBranch !== branch) {
    try {
      logger.info(`[deploy] switching welby-testing branch ${ddCurrentBranch} → ${branch}`);
      await setBranch(branch);
    } catch (error) {
      await postComment(
        active.id,
        `🤖 ❌ Failed to switch welby-testing to branch \`${branch}\`: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
  }

  let taskId: string;
  try {
    await postComment(
      active.id,
      `🤖 Deploying branch \`${branch}\` (PR #${pr.number}) to \`${DOLLARDEPLOY_TESTING_HOSTNAME}\` — I'll comment again when it's done.`
    );
    const result = await buildAndDeploy();
    taskId = result.taskId;
    logger.info(`[deploy] [${active.shortLink}] build-app dispatched, task ${taskId}`);
  } catch (error) {
    await postComment(
      active.id,
      `🤖 ❌ Failed to start build for branch \`${branch}\`: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  writeState({
    currentCardId: active.id,
    currentBranch: branch,
    lastTaskId: taskId,
    lastTaskStatus: "pending",
    deployStartedAt: new Date().toISOString()
  });
};
