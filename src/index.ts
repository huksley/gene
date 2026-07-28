/**
 * Gene AI — polling daemon.
 *
 * Every N seconds: list all tracker issues carrying the `Gene` label, bucket them
 * by workflow state, and act. Active conversations (In Progress / Blocked) are
 * drained before new Todo work is picked up. Each actionable issue is mapped to
 * its forge repo and dispatched to a `claude -p` agent in a per-issue worktree;
 * the agent does the code work and writes back to the tracker + the forge itself.
 *
 * Usage (standalone binary):
 *   gene                          # dashboard (default), every Gene issue
 *   gene CLOUD-1094               # dashboard, focused on one ticket
 *   gene --headless               # poll loop, plain console log, every Gene issue
 *   gene --once CLOUD-1094        # single scan of that ticket, then exit
 * In dev the same paths run via `npm run gene` (dashboard) / `npm run headless` /
 * `npm run once`.
 *
 * The optional focus arg is `[tracker:]IDENTIFIER` — it narrows a run to a single
 * ticket (the tracker prefix, if given, must match GENE_TRACKER). Gene acts for real
 * by default; set GENE_DRY_RUN=true to preview decisions without any writes.
 */

import logger from "./logger.ts";
import { monitor } from "./monitor.ts";
import { env, WATCHED_STATES } from "./config.ts";
import { decideAction, type Action } from "./decide.ts";
import { tracker, findIssue } from "./tracker/index.ts";
import type { Comment, Issue } from "./tracker/index.ts";
import { resolveTarget, targetLabel, localPathFor, type RepoTarget } from "./repos.ts";
import { selectForge, type Forge } from "./forge/index.ts";
import { commitsBehind, detectDefaultBranch } from "./git.ts";
import { ensureWorktree, invokeAgent, worktreePathFor, type ExistingChangeRequest, type InvokeResult } from "./invoke.ts";
import { buildPrompt, type PromptIntent } from "./prompt.ts";
import { evaluateDraftPickup, evaluateReview, findMergedChangeRequest, findOpenChangeRequest, writeCursor, type ReviewContext } from "./review.ts";
import { redraft } from "./draft.ts";
import { completeFinishedParents, isParentAwaitingChildren } from "./subcards.ts";
import { dispatch as dispatchPluginEvent, setupPlugins } from "./plugins/index.ts";
import { closeDb, findInterruptedRuns, logEvent, readTokenTotal } from "./db.ts";
import { stageIssueAttachments } from "./attachments.ts";
import { listOwnedLocks, withLock } from "./lock.ts";
import { resetIssue } from "./reset.ts";
import { forkIssue } from "./fork.ts";
import { importLegacy } from "./import-legacy.ts";
import { inSea, extractAsset, readVersion } from "./sea-assets.ts";
import { selfUpdate } from "./update.ts";
import { runSandbox } from "./sandbox.ts";
import { runExport } from "./export.ts";

const summarizeAction = (action: Action): string => {
  switch (action.kind) {
    case "nothing":
      return `nothing (${action.reason})`;
    case "ask-clarification":
      return `ASK CLARIFICATION (missing: ${action.missingSections.join(", ")})`;
    case "processing":
      return "START PROCESSING";
    case "resume":
      return `RESUME (latest user comment ${action.latestUserCommentId})`;
    case "feedback":
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
const record = (issue: Issue, event: string, detail: string, data?: unknown): Promise<void> =>
  logEvent({
    tracker: tracker.name,
    identifier: issue.identifier,
    event,
    detail: env.DRY_RUN ? `(dry-run) ${detail}` : detail,
    data
  });

const intentFor = (action: Action): PromptIntent | null => {
  switch (action.kind) {
    case "processing":
    case "resume":
    case "feedback":
      return action.kind;
    default:
      return null;
  }
};

const startMessages: Record<PromptIntent, string> = {
  "processing":
    "🧬 Picking this up — exploring the code and figuring out the scope. " +
    "I'll comment again when I have a plan, a question, or a change request ready.",
  "resume":
    "🧬 Thanks for the reply — picking back up from where I left off. I'll comment again when there's an update.",
  "feedback":
    "🧬 Got your feedback — incorporating it now. I'll comment again with the next iteration.",
  "review-fix":
    "🧬 Spotted new review feedback / CI status on the change request — addressing it now and I'll push an update.",
  "continue":
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

// Plugin-event dedup state (by issue id), so each scan emits a change exactly once.
// lastSeenState drives `issue-status-changed`; seenPrUrl + lastPipeline gate the
// In-Review `pr-created` / `ci-completed` events (see emitReviewEvents).
const lastSeenState = new Map<string, string>();
const seenPrUrl = new Map<string, string>();
const lastPipeline = new Map<string, string>();

/**
 * Emit `issue-status-changed` for any issue whose tracker state moved since the last
 * scan — one chokepoint that catches daemon-driven moves AND human drags alike. First
 * sighting of an issue only seeds the map (no event), so a cold start isn't a storm.
 */
const emitStatusChanges = async (issues: Issue[]): Promise<void> => {
  for (const issue of issues) {
    const prev = lastSeenState.get(issue.identifier);
    lastSeenState.set(issue.identifier, issue.stateName);
    if (prev !== undefined && prev !== issue.stateName) {
      await dispatchPluginEvent({ kind: "issue-status-changed", issue, from: prev, to: issue.stateName });
    }
  }
};

/**
 * Emit `pr-created` (first time a change request is seen for an issue) and
 * `ci-completed` (when its CI reaches a terminal state, once per head SHA) from the
 * In-Review watchdog. One extra forge read per in-review poll — negligible at poll cadence
 * — kept isolated so it never perturbs the dispatch decision in processReview.
 */
const emitReviewEvents = async (
  issue: Issue,
  comments: Comment[],
  target: RepoTarget,
  forge: Forge
): Promise<void> => {
  let open;
  try {
    open = await findOpenChangeRequest(issue, comments, target, forge);
  } catch {
    return; // discovery is best-effort; never let event emission disturb the watchdog
  }
  if (!open) {
    return;
  }
  if (seenPrUrl.get(issue.id) !== open.url) {
    seenPrUrl.set(issue.id, open.url);
    await dispatchPluginEvent({ kind: "pr-created", issue, url: open.url, forge: forge.name });
  }
  if (open.ci.status === "success" || open.ci.status === "failed") {
    const key = `${open.headSha}:${open.ci.status}`;
    if (lastPipeline.get(issue.id) !== key) {
      lastPipeline.set(issue.id, key);
      await dispatchPluginEvent({
        kind: "ci-completed",
        issue,
        status: open.ci.status === "success" ? "passed" : "failed",
        url: open.ci.url ?? open.url
      });
    }
  }
};

/**
 * Wakes the poll loop's interval wait early, so the next scan starts now instead
 * of after POLL_INTERVAL_MS. Set while `runForever` is sleeping; null while it is
 * mid-scan (a wake then is a no-op — a scan is already underway). Triggered by the
 * tracker watch (e.g. a Trello webhook) and by the TUI's `r` refresh.
 */
let wakePoll: (() => void) | null = null;

/** Start the next scan immediately if the loop is currently waiting (else a no-op). */
const requestScan = (): void => wakePoll?.();

/**
 * Pause flag for the scan loop. While true, {@link runForever} skips `scanOnce` — no
 * new tracker polling or dispatching — but agents already in flight keep running
 * (they're fire-and-forget promises, independent of the loop). Toggled by the TUI's
 * `p`; cleared by `p` again or by `r` (refresh). See {@link setPaused}.
 */
let paused = false;

/**
 * Pause or resume the scan loop, mirroring the state into the monitor so the TUI can
 * show it. Resuming wakes the interval wait so the next scan starts now — essential,
 * because a paused loop waits without a timeout and would otherwise never wake.
 */
const setPaused = (value: boolean): void => {
  if (paused === value) {
    return;
  }
  paused = value;
  monitor.setPaused(value);
  logger.info(`${logger.tag.flow} ${value ? "paused — scan loop idle, in-flight agents keep running" : "resumed"}`);
  if (!value) {
    wakePoll?.();
  }
};

/** Stop function for the active tracker watch (webhook listener), if started. */
let stopWatch: (() => void) | null = null;

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
  if (intent === "processing" && (await tryContinueAttachedDraft(issue, comments, target, forge))) {
    return true;
  }

  return dispatchAgent(issue, comments, target, forge, intent);
};

/**
 * Draft mode is a human gate, and the prompt asking the agent for a draft is only a
 * request (see draft.ts) — so when a run finishes, overrule an agent that left its
 * change request ready for review. Off by default; when GENE_DRAFT_CHANGE_REQUEST is
 * unset this costs nothing. Best-effort: a forge hiccup here never fails the run.
 */
const enforceDraftMode = async (
  issue: Issue,
  comments: Comment[],
  target: RepoTarget,
  forge: Forge
): Promise<void> => {
  if (!env.DRAFT_CHANGE_REQUEST) {
    return;
  }
  try {
    const detail = await redraft(await findOpenChangeRequest(issue, comments, target, forge), target, forge);
    if (detail) {
      await record(issue, "draft-enforced", detail);
    }
  } catch (error) {
    logger.warn(
      `${logger.tag.flow} [${issue.identifier}] draft-mode enforcement failed:`,
      error instanceof Error ? error.message : error
    );
  }
};

type DispatchExtras = {
  /** Forge review state to feed the prompt (review-fix / continue). */
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

  // Register the eligible task with the monitor up front — before the cap and
  // dry-run gates below — so the dashboard lists it immediately as "queued": in
  // dry-run (where no agent ever spawns), while deferred at the concurrency cap,
  // and in the moment before the child starts. The running/done transitions arrive
  // later from invoke.ts (agentSpawned / agentFinished). No-op cost in console mode.
  const workBranch = extras.existing?.branch ?? issue.branchName;
  monitor.agentDispatched(issue.identifier, intent, targetLabel(target), workBranch, issue.title);
  void dispatchPluginEvent({ kind: "agent-started", issue, intent });

  if (isAtConcurrencyCap()) {
    logger.info(
      `${logger.tag.flow} [${issue.identifier}] at concurrency cap (${inFlight.size}/${env.MAX_CONCURRENT}) — deferring`
    );
    return true;
  }

  await record(
    issue,
    "dispatch",
    `${intent} → ${targetLabel(target)} [${forge.name}] ⎇ ${workBranch}`,
    { title: issue.title }
  );

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

  // Live: run everything below inside the per-issue lock, fire-and-forget. The
  // monitor already has this run as "queued" (registered above).
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
    .then(async result => {
      if (result === "skipped") {
        logger.info(`${logger.tag.flow} [${issue.identifier}] another run holds the lock — skipping`);
        return;
      }
      // Silent crash / transient exhaustion: exited code 0 but never produced a
      // success result, or dropped the API socket mid-stream. Surface it.
      const stalled = result.exitCode === 0 && (result.transientFailure || !result.sawSuccessResult);
      if (stalled && !monitor.isCancelled(issue.identifier)) {
        await postStalledBlock(issue, result);
      }
      await enforceDraftMode(issue, comments, target, forge);
    })
    .catch(error => {
      logger.error(
        `${logger.tag.flow} [${issue.identifier}] spawn failed:`,
        error instanceof Error ? error.message : error
      );
    })
    .finally(() => {
      inFlight.delete(issue.id);
      // Finalize any monitor entry that never reached a clean outcome (lock held by
      // another process, spawn threw) — a no-op once invokeAgent recorded a terminal
      // status, so the normal done/error/cancelled outcome is preserved.
      monitor.agentSettled(issue.identifier);
      void dispatchPluginEvent({
        kind: "agent-finished",
        issue,
        status: monitor.getAgent(issue.identifier)?.status ?? "done"
      });
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

/** Comment body for a run that stalled (transient API drop or silent crash). */
const buildStalledComment = (result: InvokeResult): string => {
  const why = result.transientFailure
    ? "my connection to the model API dropped mid-run"
    : "my run ended without producing a final result (the agent exited mid-flight)";
  return [
    `🧬 I stopped before finishing — ${why}.`,
    "",
    "Nothing is broken: the worktree is preserved with whatever I'd already done. " +
      "**Reply here** (e.g. \"go ahead\" or \"retry\") and I'll resume from where I left off.",
    result.transientReason ? `\nLast error seen: \`${result.transientReason.slice(0, 200)}\`` : ""
  ]
    .filter(Boolean)
    .join("\n");
};

/**
 * A run exited 'cleanly' (code 0) but never finished — a dropped API socket or a
 * silent crash. Post an explanatory comment and move the issue to BLOCKED so a
 * human sees it and a reply re-dispatches a resume, instead of the issue silently
 * stalling in ACTIVE_STATE (decideAction returns `nothing` for it). Best-effort.
 */
const postStalledBlock = async (issue: Issue, result: InvokeResult): Promise<void> => {
  try {
    await tracker.postComment(issue, buildStalledComment(result));
    await tracker.moveToState(issue, env.BLOCKED_STATE);
    await record(
      issue,
      "stalled",
      result.transientFailure ? "transient API drop — moved to Blocked" : "silent crash (no success result) — moved to Blocked"
    );
    logger.warn(`${logger.tag.flow} [${issue.identifier}] run stalled — posted block, moved to "${env.BLOCKED_STATE}"`);
  } catch (error) {
    logger.error(
      `${logger.tag.flow} [${issue.identifier}] failed to post stalled block:`,
      error instanceof Error ? error.message : error
    );
  }
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
  // Surface pr-created / ci-completed to plugins (deduped) before the dispatch
  // decision below — isolated so event emission never affects the watchdog outcome.
  await emitReviewEvents(issue, comments, target, forge);

  // When DONE_STATE is configured, a merged change request ends the lifecycle:
  // move the issue to Done and stop — no point polling CI on a merged CR.
  if (env.DONE_STATE) {
    let merged;
    try {
      merged = await findMergedChangeRequest(issue, comments, target, forge);
    } catch (error) {
      logger.warn(
        `${logger.tag.flow} [${issue.identifier}] merged-CR check failed:`,
        error instanceof Error ? error.message : error,
        { cause: error }
      );
      merged = null;
    }

    if (merged) {
      logger.info(`${logger.tag.flow} [${issue.identifier}] ${merged.url} merged — moving to "${env.DONE_STATE}"`);
      await record(issue, "merged", `PR ${merged.iid} merged, issue ${issue.identifier} moved to "${env.DONE_STATE}"`);
      try {
        await tracker.postComment(
          issue,
          `🧬 ${forge.changeRequestTerm} merged (${merged.url}) — moving this to **${env.DONE_STATE}**.`
        );
        await tracker.moveToState(issue, env.DONE_STATE);
        // Reflect the terminal state on the dashboard immediately, rather than waiting
        // for the next scan to sweep it: update the STATE column and retire the stage.
        monitor.setIssueState(issue.identifier, env.DONE_STATE);
        monitor.markIssueDone(issue.identifier);
      } catch (error) {
        logger.error(
          `${logger.tag.flow} [${issue.identifier}] failed to move to "${env.DONE_STATE}":`,
          error instanceof Error ? error.message : error,
          { cause: error }
        );
      }
      return true;
    }
  }

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
  return dispatchAgent(issue, comments, target, forge, "review-fix", {
    reviewContext: outcome.context,
    existing: { branch: outcome.context.sourceBranch, baseBranch: outcome.context.targetBranch },
    beforeSpawn: () => writeCursor(issue.identifier, outcome.nextCursor)
  });
};

/**
 * Draft pickup for a fresh Todo issue: if it already has an open change request
 * attached (matched to the target repo, found by iid so a human branch name is
 * fine), dispatch the agent to CONTINUE it (intent "continue") on the change
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
  return dispatchAgent(issue, comments, target, forge, "continue", {
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
  monitor.scanStarted();
  let all = await tracker.listIssues();

  if (issueFilter) {
    all = all.filter(i => i.identifier.toLowerCase() === issueFilter.toLowerCase());
    if (all.length === 0) {
      monitor.scanFinished(
        { trigger: 0, active: 0, blocked: 0, review: 0, done: 0, other: 0, total: 0 },
        Date.now() + env.POLL_INTERVAL_MS
      );
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
  // Done is a distinct bucket only when auto-Done is configured; otherwise the daemon
  // has no notion of a terminal state and such issues fall through to `other`.
  const done = env.DONE_STATE ? mine.filter(i => i.stateName === env.DONE_STATE) : [];
  const other = mine.length - trigger.length - active.length - blocked.length - review.length - done.length;

  logger.info(
    `${logger.tag.flow} scan @ ${scannedAt} — ${mine.length} ${env.LABEL} issue(s) assigned to ${tracker.ownerLabel()}: ` +
    `${WATCHED_STATES.trigger}=${trigger.length}, ${WATCHED_STATES.active}=${active.length}, ` +
    `${WATCHED_STATES.blocked}=${blocked.length}, ${WATCHED_STATES.review}=${review.length}, ` +
    (env.DONE_STATE ? `${env.DONE_STATE}=${done.length}, ` : "") +
    `other=${other}`
  );

  monitor.scanFinished(
    {
      trigger: trigger.length,
      active: active.length,
      blocked: blocked.length,
      review: review.length,
      done: done.length,
      other,
      total: mine.length
    },
    Date.now() + env.POLL_INTERVAL_MS
  );

  // Keep each dashboard row's STATE column in sync with the issue's current tracker
  // state, and retire the dispatch stage of any issue now in Done (its row drops the
  // stale intent for a terminal `done`). Both touch existing rows only — a ticket that
  // never ran this session is never added — so they're no-ops until an issue has a row.
  for (const issue of mine) {
    monitor.setIssueState(issue.identifier, issue.stateName);
  }
  for (const issue of done) {
    monitor.markIssueDone(issue.identifier);
  }
  // Notify plugins of any status moves since the last scan (one chokepoint for daemon
  // moves and human drags). Best-effort — never blocks the scan if a plugin is slow.
  await emitStatusChanges(mine);

  // Existing conversations take priority over new Todo work: drain In Progress +
  // Blocked, and check In-Review change requests (failing CI / new review comments),
  // before picking up anything new. A quiet In-Review issue is a no-op and doesn't defer.
  let actionableCount = 0;
  for (const issue of [...active, ...blocked, ...review]) {
    // A Shape-B parent parked while its subcards run must not be re-dispatched by a
    // stray comment — the daemon completes it (below) once every subcard reaches Done.
    if (env.DONE_STATE && isParentAwaitingChildren(issue, mine, env.DONE_STATE)) {
      logger.info(`${logger.tag.flow} [${issue.identifier}] parent awaiting subcards — leaving parked`);
      continue;
    }
    if (await processIssue(issue)) {
      actionableCount += 1;
    }
  }

  // Auto-complete any parent whose subcards are now all Done. Runs every scan (even when
  // ongoing items defer the Todo scan below) over the list already fetched — no extra calls.
  await completeFinishedParents(mine);

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


/**
 * Publish the daemon's static configuration to the monitor — the TUI header's
 * N/MAX denominator, dry-run badge, and tracker/label/assignee. Called once per run
 * *before* the poll loop (and, in UI mode, before the dashboard's first paint) so
 * the header never flashes the monitor's placeholder defaults (e.g. 0/1). Resets
 * the uptime clock, so call it exactly once. No-op cost in console mode.
 */
const publishDaemonConfig = (): void => {
  monitor.daemonStarted({
    pollIntervalMs: env.POLL_INTERVAL_MS,
    maxConcurrent: env.MAX_CONCURRENT,
    dryRun: env.DRY_RUN,
    tracker: tracker.name,
    label: env.LABEL,
    assignee: env.ASSIGNEE,
    doneState: env.DONE_STATE
  });
};

/**
 * Close the lifecycle of any run whose daemon was killed mid-flight: its latest log
 * event is `agent-start` with no outcome after it, so the dashboard would otherwise
 * resurrect it as a stale row forever. Write a closing `agent-interrupted` event so
 * the record is honest and the row reads as `interrupted`; the ticket is still in
 * the active state, so the first scan re-picks it up and continues normally. The
 * file lock is already self-healing (the owning PID is dead → reclaimed on dispatch),
 * so there's nothing to unlock here. Best-effort: a DB hiccup must not block startup.
 */
const reconcileInterruptedRuns = async (): Promise<void> => {
  let orphaned: { tracker: string; identifier: string }[];
  try {
    orphaned = await findInterruptedRuns();
  } catch (error) {
    logger.warn(
      `${logger.tag.flow} could not reconcile interrupted runs:`,
      error instanceof Error ? error.message : error
    );
    return;
  }
  if (orphaned.length === 0) {
    return;
  }
  logger.info(
    `${logger.tag.flow} reconciling ${orphaned.length} run(s) interrupted by a previous shutdown: ` +
    `${orphaned.map(o => o.identifier).join(", ")} — left in "${env.ACTIVE_STATE}", will be re-picked up`
  );
  for (const { tracker: trackerName, identifier } of orphaned) {
    await logEvent({
      tracker: trackerName,
      identifier,
      event: "agent-interrupted",
      detail: "daemon stopped mid-run; no outcome was recorded"
    });
  }
};

/**
 * Seed the monitor's running token total from the persisted lifetime sum (this
 * tracker's runs), once at startup — so the dashboard's `Tokens:` line continues
 * across restarts instead of resetting to zero. Runs before any spawn this session,
 * keeping the base disjoint from the session's live agents (no double count).
 * Best-effort: a DB hiccup just starts the session total from zero.
 */
const seedTokenTotals = async (): Promise<void> => {
  try {
    const base = await readTokenTotal(tracker.name);
    monitor.seedLifetimeTokens(base);
    if (base.in > 0 || base.out > 0) {
      logger.info(`${logger.tag.flow} restored lifetime token total: in ${base.in}, out ${base.out}`);
    }
  } catch (error) {
    logger.warn(
      `${logger.tag.flow} could not read lifetime token total:`,
      error instanceof Error ? error.message : error
    );
  }
};

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

  // Optional real-time reactivity: if the tracker supports a watch (e.g. a Trello
  // webhook), let it wake the current poll wait early. Poll-only when unsupported.
  // The TUI's `r` refresh wakes it too, via the module-level requestScan().
  if (tracker.startWatch) {
    try {
      stopWatch = await tracker.startWatch(() => wakePoll?.());
    } catch (error) {
      logger.warn(`${logger.tag.flow} could not start tracker watch:`, error instanceof Error ? error.message : error);
    }
  }

  while (true) {
    // Skip scanning while paused (`p` in the TUI) — no new tracker polling or
    // dispatching. In-flight agents are unaffected: they're fire-and-forget and
    // independent of this loop, so they keep running and reporting.
    if (!paused) {
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
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`${logger.tag.flow} scan failed:`, message, { cause: error });
        monitor.scanFailed(message);
      }
    }
    // Wait for the poll interval, but wake immediately if the tracker watch signals
    // activity. The per-issue debounce (isWithinDebounceWindow) still defers work on
    // a just-edited issue to the following cycle, so an early wake can't act too soon.
    // While paused there's no next scan to schedule, so wait with NO timeout — only a
    // resume (setPaused(false)) or a webhook can wake us; the paused re-check at the top
    // then skips the scan for a webhook, or runs it once `p`/`r` has cleared the flag.
    await new Promise<void>(resolve => {
      const timer = paused
        ? null
        : setTimeout(() => {
            wakePoll = null;
            resolve();
          }, env.POLL_INTERVAL_MS);
      wakePoll = () => {
        wakePoll = null;
        if (timer) {
          clearTimeout(timer);
          logger.info(`${logger.tag.flow} woken early`);
        }
        resolve();
      };
    });
  }
};

/**
 * Report any still-owned locks and close the Postgres pool. Shared by the console
 * signal handlers and the TUI's quit path (the TUI calls it *after* restoring the
 * terminal via renderer.destroy()). Does NOT exit — the caller decides when to
 * leave the process — and never throws.
 */
export const gracefulShutdown = async (signal: string): Promise<void> => {
  if (stopWatch) {
    try {
      stopWatch();
    } catch {
      /* listener already closed */
    }
    stopWatch = null;
  }
  const owned = listOwnedLocks();
  if (owned.length > 0) {
    logger.info(
      `${logger.tag.flow} received ${signal} — ${owned.length} issue(s) still in flight: ${owned.join(", ")}. ` +
      `Left in "${env.ACTIVE_STATE}"; re-trigger to resume (or reset the ticket from the dashboard).`
    );
  } else {
    logger.info(`${logger.tag.flow} received ${signal} — nothing in flight, exiting`);
  }
  try {
    await closeDb();
  } catch (error) {
    logger.error(
      `${logger.tag.flow} failed to close database:`,
      error instanceof Error ? error.message : error,
      { cause: error }
    );
  }
};

let shuttingDown = false;
const handleShutdown = (signal: string): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  void gracefulShutdown(signal).finally(() => process.exit(0));
};

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

const HELP = `gene 🧬 — autonomous AI harness powered by Claude Code: from a ticket to a mergeable pull request, completely automated

Usage:
  gene [TICKET]              Launch the dashboard (default).
  gene --headless [TICKET]   Run the daemon without the dashboard (logs to stdout).
  gene --once [TICKET]       Run a single scan, then exit.
  gene --update [--force]    Download and install the latest release in place.
  gene sandbox [CMD ...]     Build/run the embedded microsandbox (try: gene sandbox help).
  gene export [FILE]         Stream the whole state store to JSON (default: gene-export.json).
  gene --help, -h            Show this help.
  gene --version, -v         Print the version.

TICKET is an optional [tracker:]IDENTIFIER focus (e.g. CLOUD-1094) that narrows the
run to a single issue; the tracker prefix, if given, must match GENE_TRACKER.

Configuration is read from the environment first, then from .gene.config (secrets and
per-machine overrides; gitignored) and gene.config (committed defaults) in the current
directory. Both are optional KEY=VALUE files and earlier sources win:
env > .gene.config > gene.config. Set GENE_CONFIG to relocate gene.config. Gene acts
for real by default; set GENE_DRY_RUN=true to preview decisions without writing back.
`;

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);

  // `gene sandbox …` forwards every remaining arg to the embedded microsandbox
  // driver (base/run/versions/help/…). It does its own flag parsing, so this runs
  // before gene's own --help/--version handling.
  if (argv[0] === "sandbox") {
    process.exit(await runSandbox(argv.slice(1)));
  }

  // `gene export [FILE]` streams the whole state store to a JSON file, then exits.
  // A leading-dash arg isn't a path (so `export --foo` won't create a file named
  // "--foo") — fall back to the default name in that case.
  if (argv[0] === "export") {
    const fileArg = argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined;
    try {
      await runExport(fileArg);
    } catch (error) {
      logger.error(`${logger.tag.export} export failed:`, error instanceof Error ? error.message : error);
      await closeDb();
      process.exit(1);
    }
    await closeDb();
    return;
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`gene ${readVersion()}\n`);
    return;
  }

  if (argv.includes("--update")) {
    const ok = await selfUpdate({ force: argv.includes("--force") });
    process.exit(ok ? 0 : 1);
  }

  // Undocumented: replay a legacy SQL dump into the configured store (ideally a
  // shared Postgres) and exit. Kept off the help text on purpose.
  const legacyIdx = argv.indexOf("--import-legacy");
  if (legacyIdx !== -1) {
    const file = argv[legacyIdx + 1];
    if (!file) {
      logger.error(`${logger.tag.flow} --import-legacy needs a path to a .sql dump`);
      process.exit(1);
    }
    try {
      await importLegacy(file);
    } catch (error) {
      logger.error(`${logger.tag.flow} import failed:`, error instanceof Error ? error.message : error, { cause: error });
      await closeDb();
      process.exit(1);
    }
    await closeDb();
    return;
  }

  const issueFilter = parseIssueFilter(process.argv);
  const once = argv.includes("--once");
  // The dashboard is the default; --headless (alias --console / --no-ui) runs the
  // daemon as a plain console log instead. --once is inherently headless.
  const headless = argv.includes("--headless") || argv.includes("--console") || argv.includes("--no-ui");
  const useUi = !once && !headless;

  // Load lifecycle observers (GENE_PLUGINS) once, before any scan can emit an event.
  await setupPlugins();

  // The TUI installs its own signal + key handling (it must restore the terminal
  // before exiting), so only the console paths get the plain signal handlers.
  if (!useUi) {
    process.on("SIGINT", () => handleShutdown("SIGINT"));
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  }

  if (once) {
    publishDaemonConfig();
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
    return;
  }

  if (useUi) {
    // Inside the single executable the OpenTUI native library is embedded as an
    // asset; extract it and hand its path to the bundled platform shim BEFORE the UI
    // module (and thus @opentui/core) loads. In dev the real platform package
    // resolves the dylib itself, so this is skipped.
    if (inSea()) {
      (globalThis as { __GENE_OPENTUI_DYLIB__?: string }).__GENE_OPENTUI_DYLIB__ =
        extractAsset("libopentui.dylib", "libopentui.dylib");
    }
    // Dynamic import so @opentui/core (and its native FFI renderer) is loaded ONLY
    // in UI mode — headless mode never touches FFI. startUi mounts the renderer,
    // kicks off the poll loop, and owns shutdown.
    try {
      const { startUi } = await import("./ui/app.ts");
      // Populate the monitor before startUi reads its first snapshot, so the header
      // shows the real N/MAX + flags from the first frame (not the placeholder 0/1).
      publishDaemonConfig();
      await startUi({
        runForever: () => runForever(issueFilter),
        // Close any runs orphaned by a previous shutdown and restore the lifetime
        // token total, then let the UI reseed so rows read as `interrupted` instead
        // of a stale `agent-start`. startUi runs this off the first frame, so a cold
        // DB never delays the UI mounting.
        reconcile: async () => {
          await reconcileInterruptedRuns();
          await seedTokenTotals();
        },
        // `r` on the dashboard reseeds the table *and* wakes the poll loop so the
        // next scan starts now instead of after POLL_INTERVAL_MS.
        requestScan,
        // `p` toggles the scan loop's pause; `r` also resumes via setPaused(false).
        setPaused,
        shutdown: gracefulShutdown,
        // `R` inside a ticket resets it (worktree/branch/lock + back to Todo). The
        // pool stays open (the daemon owns it) — resetIssue doesn't close the DB.
        reset: identifier => resetIssue(identifier),
        // `F` inside a ticket checks its work branch out into the dir Gene was launched
        // from (REPO_ROOT), when that dir shares the ticket repo's origin and has a clean
        // tree. Purely local (fetch + checkout) — no tracker/forge writes, never throws.
        fork: identifier => forkIssue(identifier),
        // Shift+`R` on the dashboard removes a ticket from Gene: drop the Gene label so
        // the next scan won't pick it up again (the UI cancels any live agent first).
        // Local worktree/branch are left intact — use reset for that. Drop the label
        // FIRST and only persist the `removed` event once it's actually gone, so a failed
        // removal leaves the ticket on the board (returning `false` tells the UI to keep
        // the row). The `removed` event is what drops the row for good: buildHistorySeed
        // skips a group whose `removed` is its latest run event (a re-dispatch logs a fresh
        // `dispatch`/`agent-start` after it, so the row returns on its own). Under dry-run
        // nothing is written, so the event is skipped too (else it would hide the row for
        // good despite the label never being touched).
        removeFromGene: async identifier => {
          const issue = await findIssue(identifier);
          const markRemoved = async (): Promise<void> => {
            if (!env.DRY_RUN) {
              await logEvent({ tracker: tracker.name, identifier, event: "removed", detail: `dropped from ${env.LABEL}` });
            }
          };
          if (!issue) {
            // Not among the Gene-labelled issues — it may already be out of the label.
            // Nothing to clear, so treat it as removed and drop the (stale) row.
            logger.warn(
              `${logger.tag.flow} could not find ${identifier} on ${tracker.name} — it may already be out of ${env.LABEL}; dropping it from the dashboard`
            );
            await markRemoved();
            return true;
          }
          const removed = await tracker.removeGeneLabel(issue);
          if (removed) {
            await markRemoved();
          }
          return removed;
        }
      });
    } catch (error) {
      logger.error(
        `${logger.tag.flow} could not start the dashboard — it needs Node ≥ 26.3.0 with ` +
        `--experimental-ffi. Run \`gene --headless\` for the plain console instead.`,
        error instanceof Error ? error.message : error
      );
      process.exit(1);
    }
    return;
  }

  // Headless daemon (the previous default): plain console log, no TUI.
  publishDaemonConfig();
  // No dashboard to reseed, so just close orphaned runs and restore the lifetime
  // token total before the first scan picks the still-active tickets back up.
  await reconcileInterruptedRuns();
  await seedTokenTotals();
  await runForever(issueFilter);
};

main().catch(error => {
  logger.error(`${logger.tag.flow} fatal:`, error instanceof Error ? error.message : error, { cause: error });
  process.exit(1);
});
