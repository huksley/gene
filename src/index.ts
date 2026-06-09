/**
 * Gene AI — polling daemon.
 *
 * Every N seconds: list all tracker issues carrying the `Gene` label, bucket them
 * by workflow state, and act. Active conversations (In Progress / Blocked) are
 * drained before new Todo work is picked up. Each actionable issue is mapped to
 * its forge repo and dispatched to a `claude -p` agent in a per-issue worktree;
 * the agent does the code work and writes back to the tracker + the forge itself.
 *
 * Usage:
 *   npm run gene                 # forever (poll loop)
 *   npm run gene:once            # single scan, then exit
 *
 * Set GENE_DRY_RUN=true (the default) to preview decisions without any writes.
 */

import logger from "./logger.ts";
import { env, WATCHED_STATES } from "./config.ts";
import { decideAction, type Action } from "./decide.ts";
import { tracker } from "./tracker/index.ts";
import type { Comment, Issue } from "./tracker/index.ts";
import { resolveTarget, targetLabel, localPathFor, type RepoTarget } from "./repos.ts";
import { selectForge, type Forge } from "./forge/index.ts";
import { commitsBehind, detectDefaultBranch } from "./git.ts";
import { ensureWorktree, invokeAgent, worktreePathFor, type ExistingChangeRequest } from "./invoke.ts";
import { buildPrompt, type PromptIntent } from "./prompt.ts";
import { evaluateDraftPickup, evaluateReview, writeCursor, type ReviewContext } from "./review.ts";
import { closeDb, logEvent } from "./db.ts";
import { stageIssueAttachments } from "./attachments.ts";
import { listOwnedLocks, withLock } from "./lock.ts";

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
    case "check-review":
      return "CHECK REVIEW (forge CI + comments)";
    default: {
      const _exhaustive: never = action;
      return `unknown ${JSON.stringify(_exhaustive)}`;
    }
  }
};

/**
 * Append a line to the issue's activity log in the state store (db.ts) — a
 * persistent, per-issue trail of what the daemon did, surfaced by `npm run log`.
 * Best-effort (never throws); dry-run actions are flagged so the log stays honest.
 */
const record = (issue: Issue, event: string, detail: string): Promise<void> =>
  logEvent({
    tracker: tracker.name,
    identifier: issue.identifier,
    event,
    detail: env.DRY_RUN ? `(dry-run) ${detail}` : detail
  });

const intentFor = (action: Action): PromptIntent | null => {
  switch (action.kind) {
    case "start-processing":
    case "resume-from-block":
    case "handle-user-feedback":
      return action.kind;
    default:
      return null;
  }
};

const startMessages: Record<PromptIntent, string> = {
  "start-processing":
    "🧬 Picking this up — exploring the code and figuring out the scope. " +
    "I'll comment again when I have a plan, a question, or a change request ready.",
  "resume-from-block":
    "🧬 Thanks for the reply — picking back up from where I left off. I'll comment again when there's an update.",
  "handle-user-feedback":
    "🧬 Got your feedback — incorporating it now. I'll comment again with the next iteration.",
  "address-review":
    "🧬 Spotted new review feedback / CI status on the change request — addressing it now and I'll push an update.",
  "continue-draft":
    "🧬 There's already a change request attached here — picking it up to finish the work, fix CI, and address review comments."
};

const buildClarificationComment = (missing: string[]): string => {
  const list = missing.map(section => `- \`${section}\``).join("\n");
  return [
    "🧬 I can't start work on this issue yet — its description is missing required section(s).",
    "",
    "**Missing:**",
    list,
    "",
    "Please add the missing section(s) to the description, then reply here and I'll re-evaluate.",
    "",
    "If something else is unclear, just reply and I'll pick up where this left off."
  ].join("\n");
};

const postStartComment = async (issue: Issue, intent: PromptIntent): Promise<void> => {
  try {
    await tracker.postComment(issue, startMessages[intent]);
  } catch (error) {
    logger.warn(
      `[gene] [${issue.identifier}] could not post start comment:`,
      error instanceof Error ? error.message : error
    );
  }
};

const postClarificationAndBlock = async (issue: Issue, missing: string[]): Promise<void> => {
  try {
    await tracker.postComment(issue, buildClarificationComment(missing));
  } catch (error) {
    logger.error(
      `[gene] [${issue.identifier}] failed to post clarification:`,
      error instanceof Error ? error.message : error
    );
    return;
  }
  try {
    await tracker.moveToState(issue, env.BLOCKED_STATE);
  } catch (error) {
    logger.warn(
      `[gene] [${issue.identifier}] could not move to "${env.BLOCKED_STATE}":`,
      error instanceof Error ? error.message : error
    );
  }
  await record(issue, "clarification", `missing section(s): ${missing.join(", ")} → ${env.BLOCKED_STATE}`);
};

/** Most recent human-meaningful activity, used to debounce rapid edits/comments. */
const lastActivityIso = (issue: Issue, comments: Comment[]): string =>
  comments.length > 0 ? comments[comments.length - 1]!.createdAt : issue.updatedAt;

const isWithinDebounceWindow = (iso: string): boolean => {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) {
    return false;
  }
  return Date.now() - t < env.DEBOUNCE_MS;
};

/**
 * Local tracker of running agent spawns, keyed by issue UUID. The on-disk lock
 * (lock.ts) is the authoritative race guard; this map is a faster local check
 * and enforces the concurrency cap.
 */
const inFlight = new Map<string, Promise<unknown>>();
const isAtConcurrencyCap = (): boolean => inFlight.size >= env.MAX_CONCURRENT;

/**
 * Returns true if the issue needed any action this cycle (anything but
 * `nothing`). Used to give active conversations priority over new Todo work.
 * Live spawns are fire-and-forget; the inFlight map prevents double-spawning.
 */
const processIssue = async (issue: Issue): Promise<boolean> => {
  const comments = await tracker.getComments(issue);
  const action = decideAction(issue, comments);
  logger.info(`[gene] [${issue.identifier}] "${issue.title}" → ${summarizeAction(action)}`);

  if (action.kind === "nothing") {
    return false;
  }

  if (isWithinDebounceWindow(lastActivityIso(issue, comments))) {
    logger.info(`[gene] [${issue.identifier}] debouncing recent activity — will retry next poll`);
    return true;
  }

  if (action.kind === "ask-clarification") {
    await postClarificationAndBlock(issue, action.missingSections);
    return true;
  }

  // Per-issue target: the first GitLab/GitHub link in the issue (forge inferred
  // from its host), else the team's default repo. selectForge keys off that.
  // Needed by both the In-Review check and a normal dispatch.
  const target = resolveTarget(issue, comments);
  if (!target) {
    logger.warn(
      `[gene] [${issue.identifier}] no GitLab/GitHub link in the issue and no default repo for ` +
      `team "${issue.teamKey}" — skipping (add a link to the issue, or map the team via GENE_REPO_MAP)`
    );
    return false;
  }
  const forge = selectForge(target.forge);

  // In Review: poll the forge for failing CI / new review comments rather than dispatch blind.
  if (action.kind === "check-review") {
    return processReview(issue, comments, target, forge);
  }

  const intent = intentFor(action);
  if (intent === null) {
    return false;
  }

  // A fresh Todo issue may already carry an open change request (a human attached a
  // draft, or a prior run opened one). Continue it instead of starting from scratch.
  if (intent === "start-processing" && (await tryContinueAttachedDraft(issue, comments, target, forge))) {
    return true;
  }

  return dispatchAgent(issue, comments, target, forge, intent);
};

type DispatchExtras = {
  /** Forge review state to feed the prompt (address-review / continue-draft). */
  reviewContext?: ReviewContext;
  /** When continuing an existing change request: its source branch + merge target. */
  existing?: ExistingChangeRequest;
  /** Runs inside the lock, just before the agent spawns (e.g. advance the review cursor). */
  beforeSpawn?: () => Promise<void>;
};

/**
 * Dispatch the agent for an issue: post the start comment, move it to the active
 * state, build the prompt, and spawn `claude -p` in its worktree (fire-and-forget).
 * Shared by the normal Todo/Blocked/feedback path and the In-Review path — they
 * differ only in the intent, the optional review context, and a pre-spawn hook.
 * Returns true once the issue is accounted for (dispatched, running, or deferred).
 */
const dispatchAgent = async (
  issue: Issue,
  comments: Comment[],
  target: RepoTarget,
  forge: Forge,
  intent: PromptIntent,
  extras: DispatchExtras = {}
): Promise<boolean> => {
  if (inFlight.has(issue.id)) {
    logger.info(`[gene] [${issue.identifier}] already running in this daemon — skipping`);
    return true;
  }
  if (isAtConcurrencyCap()) {
    logger.info(
      `[gene] [${issue.identifier}] at concurrency cap (${inFlight.size}/${env.MAX_CONCURRENT}) — deferring`
    );
    return true;
  }

  await record(issue, "dispatch", `${intent} → ${targetLabel(target)} [${forge.name}]`);

  if (env.DRY_RUN) {
    // Preview only — no clone, no worktree, no spawn, no writes (the write helpers
    // log their would-be effect). Use the notional worktree path; no drift/attachments.
    await postStartComment(issue, intent);
    await tracker.moveToState(issue, env.ACTIVE_STATE);
    const previewPath = worktreePathFor(target, issue);
    const baseBranch =
      extras.existing?.baseBranch ?? target.ref ?? (await detectDefaultBranch(localPathFor(target)));
    const workBranch = extras.existing?.branch ?? issue.branchName;
    const prompt = buildPrompt({
      issue,
      comments,
      worktreePath: previewPath,
      baseBranch,
      intent,
      attachmentRelativePaths: [],
      commitsBehind: 0,
      forge,
      workBranch,
      repoLabel: targetLabel(target),
      subdir: target.subdir,
      reviewContext: extras.reviewContext
    });
    logger.info(
      `[gene] [${issue.identifier}] (dry-run) would dispatch ${intent} → ${targetLabel(target)} ` +
      `[${forge.name}] (branch "${workBranch}", base "${baseBranch}", prompt ${prompt.length} chars)`
    );
    return true;
  }

  // Live: everything below runs inside the per-issue lock, fire-and-forget.
  const spawnPromise = withLock(issue.identifier, async () => {
    await postStartComment(issue, intent);
    await tracker.moveToState(issue, env.ACTIVE_STATE);
    // Advance any review cursor now we're committed to running, so a re-poll while
    // the agent works doesn't re-dispatch for the same CI failure / comment.
    if (extras.beforeSpawn) {
      await extras.beforeSpawn();
    }

    const { worktreePath, baseBranch, workBranch } = await ensureWorktree(
      target,
      issue,
      forge,
      extras.existing
    );
    const drift = await commitsBehind(worktreePath, baseBranch);
    if (drift > 0) {
      logger.info(`[gene] [${issue.identifier}] ${drift} commit(s) behind origin/${baseBranch}`);
    }

    let attachmentRelativePaths: string[] = [];
    try {
      const staged = await stageIssueAttachments(issue, comments, worktreePath);
      attachmentRelativePaths = staged.map(s => s.relativePath);
    } catch (error) {
      logger.warn(
        `[gene] [${issue.identifier}] failed to stage attachments:`,
        error instanceof Error ? error.message : error
      );
    }

    const prompt = buildPrompt({
      issue,
      comments,
      worktreePath,
      baseBranch,
      intent,
      attachmentRelativePaths,
      commitsBehind: drift,
      forge,
      workBranch,
      repoLabel: targetLabel(target),
      subdir: target.subdir,
      reviewContext: extras.reviewContext
    });
    return invokeAgent({ issue, prompt, worktreePath, forge });
  })
    .then(result => {
      if (result === "skipped") {
        logger.info(`[gene] [${issue.identifier}] another run holds the lock — skipping`);
      }
    })
    .catch(error => {
      logger.error(
        `[gene] [${issue.identifier}] spawn failed:`,
        error instanceof Error ? error.message : error
      );
    })
    .finally(() => {
      inFlight.delete(issue.id);
      logger.info(
        `[gene] [${issue.identifier}] spawn complete (${inFlight.size}/${env.MAX_CONCURRENT} in flight)`
      );
    });

  inFlight.set(issue.id, spawnPromise);
  logger.info(
    `[gene] [${issue.identifier}] spawned in background (${inFlight.size}/${env.MAX_CONCURRENT} in flight)`
  );
  return true;
};

/**
 * In-Review handling: ask the forge whether the open change request has failing
 * CI or new human review comments (review.ts), and dispatch the agent to address
 * them if so. CI still running, or nothing new since last check, is a no-op — the
 * daemon then proceeds to other issues. Returns true only if it actually acted, so
 * a quiet In-Review issue doesn't hold up new Todo work.
 */
const processReview = async (
  issue: Issue,
  comments: Comment[],
  target: RepoTarget,
  forge: Forge
): Promise<boolean> => {
  let outcome;
  try {
    outcome = await evaluateReview(issue, comments, target, forge);
  } catch (error) {
    logger.warn(
      `[gene] [${issue.identifier}] review check failed:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }

  if (!outcome.act) {
    logger.info(`[gene] [${issue.identifier}] in review — ${outcome.reason}`);
    return false;
  }

  logger.info(`[gene] [${issue.identifier}] in review — ${outcome.reason}; dispatching a fix`);
  await record(issue, "review", outcome.reason);
  return dispatchAgent(issue, comments, target, forge, "address-review", {
    reviewContext: outcome.context,
    existing: { branch: outcome.context.sourceBranch, baseBranch: outcome.context.targetBranch },
    beforeSpawn: () => writeCursor(issue.identifier, outcome.nextCursor)
  });
};

/**
 * Draft pickup for a fresh Todo issue: if it already has an open change request
 * attached (matched to the target repo, found by iid so a human branch name is
 * fine), dispatch the agent to CONTINUE it (intent "continue-draft") on the change
 * request's own source branch. Returns true if it acted or is intentionally
 * waiting (CI in flight); false when nothing is attached, so the caller starts fresh.
 */
const tryContinueAttachedDraft = async (
  issue: Issue,
  comments: Comment[],
  target: RepoTarget,
  forge: Forge
): Promise<boolean> => {
  let outcome;
  try {
    outcome = await evaluateDraftPickup(issue, comments, target, forge);
  } catch (error) {
    logger.warn(
      `[gene] [${issue.identifier}] draft-pickup check failed:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
  if (!outcome) {
    return false; // nothing attached — caller proceeds with a fresh start
  }
  if (!outcome.act) {
    // An attached change request exists but CI is mid-flight: wait, don't start a
    // parallel fresh run on the issue's own branch.
    logger.info(`[gene] [${issue.identifier}] attached change request — ${outcome.reason}`);
    return true;
  }
  logger.info(`[gene] [${issue.identifier}] attached change request — ${outcome.reason}; continuing it`);
  await record(issue, "draft", outcome.reason);
  return dispatchAgent(issue, comments, target, forge, "continue-draft", {
    reviewContext: outcome.context,
    existing: { branch: outcome.context.sourceBranch, baseBranch: outcome.context.targetBranch },
    beforeSpawn: () => writeCursor(issue.identifier, outcome.nextCursor)
  });
};

const scanOnce = async (): Promise<void> => {
  const scannedAt = new Date().toISOString();
  const all = await tracker.listIssues();

  // Only work issues assigned to the configured owner (env.ASSIGNEE, default "me").
  const mine = all.filter(i => tracker.isAssignedToOwner(i));
  const skipped = all.filter(i => !tracker.isAssignedToOwner(i));
  if (skipped.length > 0) {
    logger.info(
      `[gene] skipping ${skipped.length} ${env.LABEL} issue(s) not assigned to ${tracker.ownerLabel()}: ` +
      skipped.map(i => `${i.identifier} (${i.assigneeName ?? "unassigned"})`).join(", ")
    );
  }

  const trigger = mine.filter(i => i.stateName === WATCHED_STATES.trigger);
  const active = mine.filter(i => i.stateName === WATCHED_STATES.active);
  const blocked = mine.filter(i => i.stateName === WATCHED_STATES.blocked);
  const review = mine.filter(i => i.stateName === WATCHED_STATES.review);
  const other = mine.length - trigger.length - active.length - blocked.length - review.length;

  logger.info(
    `[gene] scan @ ${scannedAt} — ${mine.length} ${env.LABEL} issue(s) assigned to ${tracker.ownerLabel()}: ` +
    `${WATCHED_STATES.trigger}=${trigger.length}, ${WATCHED_STATES.active}=${active.length}, ` +
    `${WATCHED_STATES.blocked}=${blocked.length}, ${WATCHED_STATES.review}=${review.length}, other=${other}`
  );

  // Existing conversations take priority over new Todo work: drain In Progress +
  // Blocked, and check In-Review change requests (failing CI / new review comments),
  // before picking up anything new. A quiet In-Review issue is a no-op and doesn't defer.
  let actionableCount = 0;
  for (const issue of [...active, ...blocked, ...review]) {
    if (await processIssue(issue)) {
      actionableCount += 1;
    }
  }

  if (actionableCount > 0) {
    logger.info(
      `[gene] deferring ${WATCHED_STATES.trigger} scan — ${actionableCount} ongoing item(s) need attention`
    );
    return;
  }

  for (const issue of trigger) {
    await processIssue(issue);
  }
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const runForever = async (): Promise<void> => {
  logger.info(
    `[gene] starting (label=${env.LABEL}, interval=${env.POLL_INTERVAL_MS}ms, ` +
    `debounce=${env.DEBOUNCE_MS}ms, maxConcurrent=${env.MAX_CONCURRENT}, dryRun=${env.DRY_RUN})`
  );
  while (true) {
    try {
      await scanOnce();
    } catch (error) {
      logger.error("[gene] scan failed:", error instanceof Error ? error.message : error);
    }
    await sleep(env.POLL_INTERVAL_MS);
  }
};

let shuttingDown = false;
const handleShutdown = (signal: string): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const owned = listOwnedLocks();
  if (owned.length > 0) {
    logger.info(
      `[gene] received ${signal} — ${owned.length} issue(s) still in flight: ${owned.join(", ")}. ` +
      `Left in "${env.ACTIVE_STATE}"; re-trigger or \`npm run gene:reset -- <ID>\` as needed.`
    );
  } else {
    logger.info(`[gene] received ${signal} — nothing in flight, exiting`);
  }
  process.exit(0);
};

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

const main = async (): Promise<void> => {
  if (process.argv.includes("--once")) {
    await scanOnce();
    // Let any live spawns kicked off this scan finish before exiting.
    await Promise.allSettled([...inFlight.values()]);
    // Release the PGlite handles, else its WASM runtime keeps the process alive.
    await closeDb();
    return;
  }
  await runForever();
};

main().catch(error => {
  logger.error("[gene] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
