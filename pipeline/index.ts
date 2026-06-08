/**
 * AI Code Assistant — polling daemon.
 *
 * Scans the Trello "Dev" board's pipeline lists every N seconds. For each card
 * needing action: fetches comments, builds the agent prompt, spawns `claude -p`
 * inside a per-card worktree to perform the work and post back to Trello.
 *
 * Usage:
 *   npm run pipeline                 # forever (poll + watch inbox)
 *   npm run pipeline -- --once       # single scan, then exit
 *
 * Required env vars (see scripts/ai-pipeline/README.md):
 *   TRELLO_API_KEY, TRELLO_TOKEN
 */

import logger from "@/lib/logger";
import { LABELS, LISTS, LIST_NAMES, env } from "./config";
import { decideAction, type Action } from "./decide";
import { existsSync, mkdirSync, watch, type FSWatcher } from "fs";
import { stageCardAttachments } from "./attachments";
import { drainInbox, inboxDir } from "./inbox";
import { commitsBehindOriginDev, ensureWorktree, invokeAgent } from "./invoke";
import { listOwnedLocks, withLock } from "./lock";
import { processTestingLane } from "./deploy";
import { buildPrompt } from "./prompt";
import {
  addLabelToCard,
  getCardComments,
  getCardsInList,
  getMember,
  postComment,
  removeLabelFromCard,
  type TrelloCard,
  type TrelloComment,
  type TrelloMember
} from "./trello";

const summarizeAction = (action: Action): string => {
  switch (action.kind) {
    case "nothing":
      return `nothing (${action.reason})`;
    case "ask-clarification":
      return `ASK CLARIFICATION (missing: ${action.missingSections.join(", ")})`;
    case "start-processing":
      return "START PROCESSING";
    case "resume-from-block":
      return `RESUME (latest user comment ${action.latestUserCommentId})`;
    case "handle-user-feedback":
      return `HANDLE FEEDBACK (latest user comment ${action.latestUserCommentId})`;
    default: {
      const _exhaustive: never = action;
      return `unknown ${JSON.stringify(_exhaustive)}`;
    }
  }
};

const memberCache = new Map<string, TrelloMember>();

const loadMembers = async (comments: TrelloComment[]): Promise<Map<string, TrelloMember>> => {
  const uniqueIds = new Set(comments.map(comment => comment.idMemberCreator));
  for (const memberId of uniqueIds) {
    if (memberCache.has(memberId)) {
      continue;
    }
    try {
      memberCache.set(memberId, await getMember(memberId));
    } catch (error) {
      logger.warn(
        `[ai-pipeline] failed to load member ${memberId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return memberCache;
};

const intentFor = (
  action: Action
): "start-processing" | "resume-from-block" | "handle-user-feedback" | null => {
  switch (action.kind) {
    case "start-processing":
    case "resume-from-block":
    case "handle-user-feedback":
      return action.kind;
    default:
      return null;
  }
};

const TEMPLATE_CARD_URL = "https://trello.com/c/xQJXf5nF";

const buildClarificationComment = (missing: string[]): string => {
  const list = missing.map(section => `- \`${section}\``).join("\n");
  return [
    "🤖 I can't start work on this card yet — its description is missing required sections.",
    "",
    "**Missing:**",
    list,
    "",
    `Please add the missing section(s) to the card description (see the [📋 card template](${TEMPLATE_CARD_URL}) for what each section should contain), then remove the \`ai:blocked\` label or add a comment so I can re-evaluate.`,
    "",
    "If something else is unclear, just reply and I'll pick up where this left off."
  ].join("\n");
};

const startMessages: Record<
  "start-processing" | "resume-from-block" | "handle-user-feedback",
  string
> = {
  "start-processing":
    "🤖 Picking this card up — exploring the code and figuring out the scope. I'll comment again when I have a plan, a question, or a PR ready.",
  "resume-from-block":
    "🤖 Thanks for the clarification — picking back up from where I left off. I'll comment again when there's an update.",
  "handle-user-feedback":
    "🤖 Got your feedback — incorporating it now. I'll comment again with the next iteration."
};

const postStartComment = async (
  card: TrelloCard,
  intent: keyof typeof startMessages
): Promise<void> => {
  try {
    await postComment(card.id, startMessages[intent]);
    logger.info(`[ai-pipeline]     [${card.shortLink}]   posted start comment (${intent})`);
  } catch (error) {
    logger.warn(
      `[ai-pipeline]     [${card.shortLink}]   could not post start comment:`,
      error instanceof Error ? error.message : error
    );
  }
};

const postClarificationAndBlock = async (
  card: TrelloCard,
  missing: string[]
): Promise<void> => {
  try {
    await postComment(card.id, buildClarificationComment(missing));
    logger.info(
      `[ai-pipeline]     [${card.shortLink}]   posted clarification comment (missing: ${missing.join(", ")})`
    );
  } catch (error) {
    logger.error(
      `[ai-pipeline]     [${card.shortLink}]   failed to post clarification:`,
      error instanceof Error ? error.message : error
    );
    return;
  }
  try {
    await addLabelToCard(card.id, LABELS.AI_BLOCKED);
    logger.info(`[ai-pipeline]     [${card.shortLink}]   applied ai:blocked label`);
  } catch (error) {
    logger.warn(
      `[ai-pipeline]     [${card.shortLink}]   could not apply ai:blocked label:`,
      error instanceof Error ? error.message : error
    );
  }
};

const isWithinDebounceWindow = (card: TrelloCard): boolean => {
  const lastActivity = new Date(card.dateLastActivity).getTime();
  if (Number.isNaN(lastActivity)) {
    return false;
  }
  return Date.now() - lastActivity < env.AI_PIPELINE_DEBOUNCE_MS;
};

/**
 * In-memory tracker of agent spawns that are currently running. Keyed by
 * card id. Cleared in the `.finally` of each spawn promise. Used to (a) skip
 * cards that already have a live spawn before we even touch Trello, and (b)
 * enforce `AI_PIPELINE_MAX_CONCURRENT`.
 *
 * Note: the on-disk file lock in `lock.ts` is still the authoritative race
 * guard — this map is just a faster local check that doesn't even bother
 * calling the filesystem when we know the spawn is ours.
 */
const inFlight = new Map<string, Promise<unknown>>();

const isAtConcurrencyCap = (): boolean => inFlight.size >= env.AI_PIPELINE_MAX_CONCURRENT;

/**
 * Returns true if the card needed any action this cycle (anything other than
 * `nothing`). Used to give In Process (AI) priority over AI Code Assistant —
 * a busy conversation defers new queue work until it's quiet.
 *
 * Spawns are FIRE-AND-FORGET: we kick off the agent and return immediately so
 * the scan loop can keep moving. The `inFlight` map prevents double-spawning a
 * single card and caps total concurrency at `AI_PIPELINE_MAX_CONCURRENT`.
 */
const processCard = async (card: TrelloCard): Promise<boolean> => {
  const comments = await getCardComments(card.id);
  const action = decideAction(card, comments);
  logger.info(
    `[ai-pipeline]     [${card.shortLink}] "${card.name}" → ${summarizeAction(action)}`
  );

  if (action.kind === "nothing") {
    return false;
  }

  if (isWithinDebounceWindow(card)) {
    logger.info(
      `[ai-pipeline]     [${card.shortLink}]   debouncing (last activity ${card.dateLastActivity}) — will retry next poll`
    );
    // Counts as "needs attention soon" — defer new queue work for now.
    return true;
  }

  if (action.kind === "ask-clarification") {
    await postClarificationAndBlock(card, action.missingSections);
    return true;
  }

  const intent = intentFor(action);
  if (intent === null) {
    return false;
  }

  if (inFlight.has(card.id)) {
    logger.info(
      `[ai-pipeline]     [${card.shortLink}]   already running in this daemon — skipping`
    );
    return true;
  }

  if (isAtConcurrencyCap()) {
    logger.info(
      `[ai-pipeline]     [${card.shortLink}]   at concurrency cap (${inFlight.size}/${env.AI_PIPELINE_MAX_CONCURRENT}) — deferring`
    );
    return true;
  }

  const members = await loadMembers(comments);
  await postStartComment(card, intent);
  const worktreePath = await ensureWorktree(card);
  const drift = commitsBehindOriginDev(worktreePath);
  if (drift > 0) {
    logger.info(
      `[ai-pipeline]     [${card.shortLink}]   ${drift} commit${drift === 1 ? "" : "s"} behind origin/dev`
    );
  }

  let attachmentRelativePaths: string[] = [];
  try {
    const staged = await stageCardAttachments(card.id, worktreePath);
    attachmentRelativePaths = staged.map(s => s.relativePath);
  } catch (error) {
    logger.warn(
      `[ai-pipeline] [${card.shortLink}] failed to stage attachments:`,
      error instanceof Error ? error.message : error
    );
  }

  const prompt = buildPrompt({
    card,
    comments,
    members,
    worktreePath,
    intent,
    attachmentRelativePaths,
    commitsBehindOriginDev: drift
  });

  // Fire-and-forget. The spawn promise registers itself in `inFlight` so this
  // and subsequent scans can see it's already running, and removes itself in
  // a `finally` so a crash or success both clear the slot.
  const spawnPromise = withLock(card.id, () => invokeAgent({ card, prompt }))
    .then(result => {
      if (result === "skipped") {
        logger.info(
          `[ai-pipeline]     [${card.shortLink}]   another run holds the lock — skipping`
        );
      }
    })
    .catch(error => {
      logger.error(
        `[ai-pipeline]     [${card.shortLink}]   spawn failed:`,
        error instanceof Error ? error.message : error
      );
    })
    .finally(() => {
      inFlight.delete(card.id);
      logger.info(
        `[ai-pipeline]     [${card.shortLink}]   spawn complete (${inFlight.size}/${env.AI_PIPELINE_MAX_CONCURRENT} slot${inFlight.size === 1 ? "" : "s"} now in flight)`
      );
    });
  inFlight.set(card.id, spawnPromise);
  logger.info(
    `[ai-pipeline]     [${card.shortLink}]   spawned in background (${inFlight.size}/${env.AI_PIPELINE_MAX_CONCURRENT} now in flight)`
  );
  return true;
};

const scanList = async (listId: string): Promise<{ actionableCount: number }> => {
  const listName = LIST_NAMES[listId] ?? listId;
  const cards = await getCardsInList(listId);
  logger.info(
    `[ai-pipeline]   list "${listName}" (${cards.length} card${cards.length === 1 ? "" : "s"})`
  );
  if (cards.length === 0) {
    logger.info("[ai-pipeline]     (empty)");
    return { actionableCount: 0 };
  }
  let actionableCount = 0;
  for (const card of cards) {
    if (await processCard(card)) {
      actionableCount += 1;
    }
  }
  return { actionableCount };
};

const scanOnce = async (): Promise<void> => {
  const scannedAt = new Date().toISOString();
  const inboxEntries = drainInbox();
  const inboxNote =
    inboxEntries.length > 0
      ? ` (inbox: ${inboxEntries.length} webhook event${inboxEntries.length === 1 ? "" : "s"})`
      : "";
  logger.info(`[ai-pipeline] scan @ ${scannedAt}${inboxNote}`);
  for (const entry of inboxEntries) {
    logger.info(`[ai-pipeline]   inbox: ${entry.actionType} on card ${entry.cardId}`);
  }

  // Priority: drain In Process (AI) first — active conversations win.
  const { actionableCount } = await scanList(LISTS.IN_PROCESS_AI);

  // Only pick up new queue work if In Process has nothing actionable.
  if (actionableCount > 0) {
    logger.info(
      `[ai-pipeline]   deferring AI Code Assistant scan — ${actionableCount} card${actionableCount === 1 ? "" : "s"} need${actionableCount === 1 ? "s" : ""} attention in In Process (AI)`
    );
  } else {
    await scanList(LISTS.AI_CODE_ASSISTANT);
  }

  // Testing lane (DollarDeploy) — independent of agent spawn lifecycle, so we
  // always run it. It's a no-op if DOLLARDEPLOY_API_KEY isn't configured.
  try {
    await processTestingLane(LISTS.TESTING_DD);
  } catch (error) {
    logger.error(
      "[ai-pipeline] testing lane scan failed:",
      error instanceof Error ? error.message : error
    );
  }
};

const sleepUntilNextPoll = (): Promise<void> => {
  return new Promise(resolve => {
    let watcher: FSWatcher | null = null;
    const timeout = setTimeout(() => {
      watcher?.close();
      resolve();
    }, env.AI_PIPELINE_POLL_INTERVAL_MS);

    const dir = inboxDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    try {
      watcher = watch(dir, (_eventType, filename) => {
        if (filename && filename.endsWith(".json")) {
          logger.info(`[ai-pipeline] inbox signal received (${filename}) — waking early`);
          clearTimeout(timeout);
          watcher?.close();
          resolve();
        }
      });
    } catch (error) {
      logger.warn(
        "[ai-pipeline] inbox watcher unavailable:",
        error instanceof Error ? error.message : error
      );
    }
  });
};

const runForever = async (): Promise<void> => {
  logger.info(
    `[ai-pipeline] starting (board=${env.AI_PIPELINE_BOARD_ID}, interval=${env.AI_PIPELINE_POLL_INTERVAL_MS}ms, debounce=${env.AI_PIPELINE_DEBOUNCE_MS}ms, maxConcurrent=${env.AI_PIPELINE_MAX_CONCURRENT})`
  );
  while (true) {
    try {
      await scanOnce();
    } catch (error) {
      logger.error(
        "[ai-pipeline] scan failed:",
        error instanceof Error ? error.message : error
      );
    }
    await sleepUntilNextPoll();
  }
};

let shuttingDown = false;
const handleShutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(`[ai-pipeline] received ${signal} — cleaning up before exit`);

  const owned = listOwnedLocks();
  if (owned.length > 0) {
    logger.info(`[ai-pipeline] removing ai:working from ${owned.length} active card(s)`);
    await Promise.all(
      owned.map(async cardId => {
        try {
          await removeLabelFromCard(cardId, LABELS.AI_WORKING);
        } catch (error) {
          logger.warn(
            `[ai-pipeline] could not remove ai:working from ${cardId}:`,
            error instanceof Error ? error.message : error
          );
        }
      })
    );
  }
  process.exit(0);
};

process.on("SIGINT", () => {
  void handleShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void handleShutdown("SIGTERM");
});

const mode = process.argv.includes("--once") ? "once" : "forever";

if (mode === "once") {
  scanOnce().catch(error => {
    logger.error("[ai-pipeline] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
} else {
  runForever().catch(error => {
    logger.error("[ai-pipeline] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
