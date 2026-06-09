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
 *   npm run gene                          # forever (poll loop), every Gene issue
 *   npm run gene:once                     # single scan, then exit
 *   npm run gene -- linear:CLOUD-1094     # focus loop: poll, but only that one ticket
 *   npm run gene:once -- CLOUD-1094       # focus once: that ticket only, then exit
 *
 * The optional focus arg is `[tracker:]IDENTIFIER` — it narrows a run to a single
 * ticket (the tracker prefix, if given, must match GENE_TRACKER). Set
 * GENE_DRY_RUN=true (the default) to preview decisions without any writes.
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
      `${logger.tag.flow} [${issue.identifier}] could not post start comment:`,
      error instanceof Error ? error.message : error
    );
  }
};

const postClarificationAndBlock = async (issue: Issue, missing: string[]): Promise<void> => {
  try {
    await tracker.postComment(issue, buildClarificationComment(missing));
  } catch (error) {
    logger.error(
      `${logger.tag.flow} [${issue.identifier}] failed to post clarification:`,
      error instanceof Error ? error.message : error
    );
    return;
  }
  try {
    await tracker.moveToState(issue, env.BLOCKED_STATE);
  } catch (error) {
    logger.warn(
      `${logger.tag.flow} [${issue.identifier}] could not move to "${env.BLOCKED_STATE}":`,
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

interface InFlightContext {
  promise?: Promise<unknown>;
  pid?: number;
  startedAt?: number;
  /** Human-readable ticket id (e.g. "ENG-123"), for the in-flight heartbeat. */
  identifier?: string;
}

/**
 * Local tracker of running agent spawns, keyed by issue UUID. The on-disk lock
 * (lock.ts) is the authoritative race guard; this map is a faster local check
 * and enforces the concurrency cap.
 */
const inFlight = new Map<string, InFlightContext>();
const isAtConcurrencyCap = (): boolean => inFlight.size >= env.MAX_CONCURRENT;

/**
 * Heartbeat line: the agents running right now — ticket, OS pid, and elapsed wall
 * time each. Lets a long poll interval with background spawns show progress instead
 * of looking hung. No-op while idle so a quiet daemon stays quiet in the log.
 */
const reportInFlight = (): void => {
  if (inFlight.size === 0) {
    return;
  }
  const now = Date.now();
  const lines = [...inFlight.values()].map(ctx => {
    const pid = ctx.pid === undefined ? "starting" : `pid ${ctx.pid}`;
    const elapsed = ctx.startedAt === undefined ? "?" : `${Math.round((now - ctx.startedAt) / 1000)}s`;
    return `${ctx.identifier ?? "?"} (${pid}, ${elapsed})`;
  });
  logger.info(`${logger.tag.flow} in flight ${inFlight.size}/${env.MAX_CONCURRENT}: ${lines.join(" · ")}`);
};

/**
 * Returns true if the issue needed any action this cycle (anything but
 * `nothing`). Used to give active conversations priority over new Todo work.
 * Live spawns are fire-and-forget; the inFlight map prevents double-spawning.
 */
const processIssue = async (issue: Issue): Promise<boolean> => {
  const comments = await tracker.getComments(issue);
  const action = decideAction(issue, comments);
  logger.info(`${logger.tag.flow} [${issue.identifier}] "${issue.title}" → ${summarizeAction(action)}`);

  if (action.kind === "nothing") {
    return false;
  }

  if (isWithinDebounceWindow(lastActivityIso(issue, comments))) {
    logger.info(`${logger.tag.flow} [${issue.identifier}] debouncing recent activity — will retry next poll`);
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
      `${logger.tag.flow} [${issue.identifier}] no repo link in the issue and no default repo for ` +
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
    logger.info(`${logger.tag.flow} [${issue.identifier}] already running in this daemon — skipping`);
    return true;
  }
  if (isAtConcurrencyCap()) {
    logger.info(
      `${logger.tag.flow} [${issue.identifier}] at concurrency cap (${inFlight.size}/${env.MAX_CONCURRENT}) — deferring`
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
      `${logger.tag.flow} [${issue.identifier}] (dry-run) would dispatch ${intent} → ${targetLabel(target)} ` +
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
      logger.info(`${logger.tag.flow} [${issue.identifier}] ${drift} commit(s) behind origin/${baseBranch}`);
    }

    let attachmentRelativePaths: string[] = [];
    try {
      const staged = await stageIssueAttachments(issue, comments, worktreePath);
      attachmentRelativePaths = staged.map(s => s.relativePath);
    } catch (error) {
      logger.warn(
        `${logger.tag.flow} [${issue.identifier}] failed to stage attachments:`,
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

    return invokeAgent({ issue, prompt, worktreePath, forge }, (pid: number) => {
      inFlight.set(issue.id, { ...inFlight.get(issue.id), pid });
    });
  })
    .then(result => {
      if (result === "skipped") {
        logger.info(`${logger.tag.flow} [${issue.identifier}] another run holds the lock — skipping`);
      }
    })
    .catch(error => {
      logger.error(
        `${logger.tag.flow} [${issue.identifier}] spawn failed:`,
        error instanceof Error ? error.message : error
      );
    })
    .finally(() => {
      inFlight.delete(issue.id);
      logger.info(
        `${logger.tag.flow} [${issue.identifier}] spawn complete (${inFlight.size}/${env.MAX_CONCURRENT} in flight)`
      );
    });

  inFlight.set(issue.id, {
    ...inFlight.get(issue.id),
    promise: spawnPromise,
    startedAt: Date.now(),
    identifier: issue.identifier
  });
  logger.info(
    `${logger.tag.flow} [${issue.identifier}] spawned in background (${inFlight.size}/${env.MAX_CONCURRENT} in flight)`
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
      `${logger.tag.flow} [${issue.identifier}] review check failed:`,
      error instanceof Error ? error.message : error,
      { cause: error }
    );
    return false;
  }

  if (!outcome.act) {
    logger.info(`${logger.tag.flow} [${issue.identifier}] in review — ${outcome.reason}`);
    return false;
  }

  logger.info(`${logger.tag.flow} [${issue.identifier}] in review — ${outcome.reason}; dispatching a fix`);
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
      `${logger.tag.flow} [${issue.identifier}] draft-pickup check failed:`,
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
    logger.info(`${logger.tag.flow} [${issue.identifier}] attached change request — ${outcome.reason}`);
    return true;
  }
  logger.info(`${logger.tag.flow} [${issue.identifier}] attached change request — ${outcome.reason}; continuing it`);
  await record(issue, "draft", outcome.reason);
  return dispatchAgent(issue, comments, target, forge, "continue-draft", {
    reviewContext: outcome.context,
    existing: { branch: outcome.context.sourceBranch, baseBranch: outcome.context.targetBranch },
    beforeSpawn: () => writeCursor(issue.identifier, outcome.nextCursor)
  });
};

/**
 * One scan cycle. With an issueFilter, narrows to that single ticket (still looked
 * up among the Gene-labelled issues, then run through the normal assignee + state
 * pipeline). Returns false only when a filter was given but matched nothing this
 * cycle — the caller decides whether that's fatal (`--once`) or just "keep waiting"
 * (the loop). An unfiltered scan always returns true.
 */
const scanOnce = async (issueFilter?: string): Promise<boolean> => {
  const scannedAt = new Date().toISOString();
  let all = await tracker.listIssues();

  if (issueFilter) {
    all = all.filter(i => i.identifier.toLowerCase() === issueFilter.toLowerCase());
    if (all.length === 0) {
      return false;
    }
  }

  // Only work issues assigned to the configured owner (env.ASSIGNEE, default "me").
  const mine = all.filter(i => tracker.isAssignedToOwner(i));
  const skipped = all.filter(i => !tracker.isAssignedToOwner(i));
  if (skipped.length > 0) {
    logger.info(
      `${logger.tag.flow} skipping ${skipped.length} ${env.LABEL} issue(s) not assigned to ${tracker.ownerLabel()}: ` +
      skipped.map(i => `${i.identifier} (${i.assigneeName ?? "unassigned"})`).join(", ")
    );
  }

  const trigger = mine.filter(i => i.stateName === WATCHED_STATES.trigger);
  const active = mine.filter(i => i.stateName === WATCHED_STATES.active);
  const blocked = mine.filter(i => i.stateName === WATCHED_STATES.blocked);
  const review = mine.filter(i => i.stateName === WATCHED_STATES.review);
  const other = mine.length - trigger.length - active.length - blocked.length - review.length;

  logger.info(
    `${logger.tag.flow} scan @ ${scannedAt} — ${mine.length} ${env.LABEL} issue(s) assigned to ${tracker.ownerLabel()}: ` +
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
      `${logger.tag.flow} deferring ${WATCHED_STATES.trigger} scan — ${actionableCount} ongoing item(s) need attention`
    );
    return true;
  }

  for (const issue of trigger) {
    await processIssue(issue);
  }
  return true;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const runForever = async (issueFilter?: string): Promise<void> => {
  logger.info(
    `${logger.tag.flow} starting (label=${env.LABEL}, interval=${env.POLL_INTERVAL_MS}ms, ` +
    `debounce=${env.DEBOUNCE_MS}ms, maxConcurrent=${env.MAX_CONCURRENT}, dryRun=${env.DRY_RUN}` +
    (issueFilter ? `, filter=${issueFilter}` : "") + ")"
  );
  // Surface in-flight agents between scans on the same cadence as the poll loop;
  // unref() so the heartbeat alone never holds the process open at shutdown.
  const heartbeat = setInterval(reportInFlight, env.POLL_INTERVAL_MS);
  heartbeat.unref();
  while (true) {
    try {
      const found = await scanOnce(issueFilter);
      if (!found) {
        // Filtered run, issue not in the labelled set yet (typo, label not applied,
        // or a transient empty list). Keep polling rather than giving up.
        logger.info(
          `${logger.tag.flow} issue "${issueFilter}" not found among ${env.LABEL} issues yet — ` +
          `waiting (next poll in ${Math.round(env.POLL_INTERVAL_MS / 1000)}s)`
        );
      }
    } catch (error) {
      logger.error(`${logger.tag.flow} scan failed:`, error instanceof Error ? error.message : error, { cause: error });
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
      `${logger.tag.flow} received ${signal} — ${owned.length} issue(s) still in flight: ${owned.join(", ")}. ` +
      `Left in "${env.ACTIVE_STATE}"; re-trigger or \`npm run gene:reset -- <ID>\` as needed.`
    );
  } else {
    logger.info(`${logger.tag.flow} received ${signal} — nothing in flight, exiting`);
  }
  process.exit(0);
};

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

const parseIssueFilter = (argv: string[]): string | undefined => {
  const raw = argv.slice(2).find(a => !a.startsWith("--"));
  if (!raw) {
    return undefined;
  }
  const colon = raw.indexOf(":");
  const prefix = colon === -1 ? undefined : raw.slice(0, colon).toLowerCase();
  const identifier = colon === -1 ? raw : raw.slice(colon + 1);
  if (prefix && prefix !== env.TRACKER) {
    logger.error(
      `${logger.tag.flow} filter "${raw}": tracker "${prefix}" ≠ GENE_TRACKER=${env.TRACKER}. This run drives ` +
      `${env.TRACKER}; use "${env.TRACKER}:${identifier}" (or set GENE_TRACKER=${prefix} and re-run).`
    );
    process.exit(1);
  }
  if (!identifier) {
    logger.error(`${logger.tag.flow} filter "${raw}": missing issue identifier (expected [tracker:]IDENTIFIER)`);
    process.exit(1);
  }
  return identifier;
};

const main = async (): Promise<void> => {
  const issueFilter = parseIssueFilter(process.argv);

  if (process.argv.includes("--once")) {
    const found = await scanOnce(issueFilter);
    if (!found) {
      // Fail fast in once-mode: the operator named a ticket that isn't there.
      logger.error(`${logger.tag.flow} unable to find issue with identifier "${issueFilter}"`);
      await closeDb();
      process.exit(1);
    }
    // Let any live spawns kicked off this scan finish before exiting. The map holds
    // context objects now, so pull out the promises (a just-registered entry may not
    // have one yet) before awaiting.
    const pending = [...inFlight.values()].map(ctx => ctx.promise);
    await Promise.allSettled(pending.filter(Boolean));
    // Close the Postgres pool, else its open sockets keep the process alive.
    await closeDb();
  } else {
    await runForever(issueFilter);
  }
};

main().catch(error => {
  logger.error(`${logger.tag.flow} fatal:`, error instanceof Error ? error.message : error, { cause: error });
  process.exit(1);
});
