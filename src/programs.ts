/**
 * Programs mode — pure helpers and the manual-fire queue. A program is a tracker
 * ticket labelled PROGRAM_LABEL; it runs on demand, writes back to the ticket, and
 * never opens a change request. Kept dependency-light and mostly pure so the lifecycle
 * is unit-testable against stub trackers (see programs.test.ts). The impure dispatch
 * lives in index.ts.
 */
import { env } from "./config.ts";
import { commentIsIgnored } from "./ignore.ts";
import { parseDirective } from "./directives.ts";
import type { Comment, Issue } from "./tracker/index.ts";

/** Drop program tickets from a coding-scan issue list (by identifier). */
export const excludePrograms = (issues: Issue[], programIds: Set<string>): Issue[] =>
  issues.filter(i => !programIds.has(i.identifier));

export type ProgramSource = "manual" | "trigger";

export type ProgramAction =
  | { kind: "nothing"; reason: string }
  | { kind: "fire"; source: ProgramSource }
  | { kind: "restart"; source: ProgramSource }
  | { kind: "resume"; latestUserCommentId: string }
  | { kind: "resume-interrupted" }
  | { kind: "stop" }
  /** In ACTIVE with no run behind it: put it back to rest (Todo) — never re-run it. */
  | { kind: "rest" };

/** A queued fire: who asked, and (for a trigger) why — surfaced in the run's prompt. */
export type FireRequest = { source: ProgramSource; reason?: string };

// --- Fire queue (manual `g` and triggers both enqueue here) -------------------------
const pendingFires = new Map<string, FireRequest>();

/** Enqueue a fire for a program (idempotent per identifier; the latest request wins). */
export const fireProgram = (identifier: string, source: ProgramSource = "manual", reason?: string): void => {
  pendingFires.set(identifier.toLowerCase(), { source, reason });
};

export const hasFireRequest = (identifier: string): boolean =>
  pendingFires.has(identifier.toLowerCase());

/** Remove and return a pending fire (undefined if none). Consuming it
 *  guarantees exactly one dispatch per request. */
export const takeFireRequest = (identifier: string): FireRequest | undefined => {
  const key = identifier.toLowerCase();
  const request = pendingFires.get(key);
  if (request !== undefined) pendingFires.delete(key);
  return request;
};

// --- Pure decision ------------------------------------------------------------------
const latestAgentComment = (comments: Comment[]): Comment | undefined => {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    if (comments[i]!.isAgent) return comments[i];
  }
  return undefined;
};

const newUserCommentsAfter = (comments: Comment[], afterIso: string | undefined): Comment[] =>
  comments.filter(
    c => !c.isAgent && (afterIso === undefined || c.createdAt > afterIso) && !commentIsIgnored(env.TRACKER, c.body)
  );

/**
 * What a run resuming from Blocked needs to see: the question Gene last asked (its latest
 * comment) and the human replies after it, oldest first.
 */
export const resumeExchange = (comments: Comment[]): Comment[] => {
  const lastAgent = latestAgentComment(comments);
  return [...(lastAgent ? [lastAgent] : []), ...newUserCommentsAfter(comments, lastAgent?.createdAt)];
};

export const decideProgramAction = (
  program: Issue,
  comments: Comment[],
  opts: {
    firePending: boolean;
    source?: ProgramSource;
    runInFlight: boolean;
    /**
     * The activity log positively records a run that never finished (its last event is
     * `agent-start`/`agent-interrupted`) — the only evidence that resuming is warranted.
     * Defaults to false so the automatic path is opt-in: a program never re-fires on
     * inference alone.
     */
    interruptedRun?: boolean;
  }
): ProgramAction => {
  const source = opts.source ?? "manual";
  if (opts.firePending) {
    return opts.runInFlight ? { kind: "restart", source } : { kind: "fire", source };
  }
  if (program.stateName === env.ACTIVE_STATE) {
    // ACTIVE with a live run: leave it. ACTIVE with nothing running locally is NOT by
    // itself a daemon-died-mid-run signal — it is equally what a program looks like
    // after a finished run restored it to a bad resting state, or after anything else
    // parked it there. Resume only against a logged unfinished run; that record is
    // closed by the run's own outcome row, so one interruption yields one resume
    // (CLOUD-2014 re-fired 394 times when this was inferred from the state alone).
    // Without that record nothing is running it, so return it to rest (Todo) — which
    // re-arms its trigger — rather than leave it In Progress forever (CLOUD-2629).
    if (opts.runInFlight) return { kind: "nothing", reason: "run in progress" };
    if (opts.interruptedRun === true) return { kind: "resume-interrupted" };
    return { kind: "rest" };
  }
  if (program.stateName === env.BLOCKED_STATE) {
    const lastAgent = latestAgentComment(comments);
    const replies = newUserCommentsAfter(comments, lastAgent?.createdAt);
    if (replies.length === 0) return { kind: "nothing", reason: "blocked, awaiting reply" };
    const latest = replies[replies.length - 1]!;
    // A "stop" directive abandons the run (Gene returns the program to rest); any other
    // reply (approve/redo/retry or plain prose) resumes it. Mirrors the coding resume
    // rails (parseDirective) so `!gene stop` works on programs too.
    if (parseDirective(latest.body)?.command === "stop") return { kind: "stop" };
    return { kind: "resume", latestUserCommentId: latest.id };
  }
  return { kind: "nothing", reason: "resting" };
};

// --- Where a run ends up ------------------------------------------------------------
/** The parts of an agent run's result that decide whether it finished. */
export type RunOutcome = {
  exitCode: number;
  sawSuccessResult: boolean;
  transientFailure: boolean;
  authFailure: boolean;
};

/** How a program run ended, as Gene saw it. */
export type ProgramEnding =
  /** The agent ran to an exit. `liveState` is the ticket's state re-read afterwards (undefined if unreadable). */
  | { kind: "finished"; result: RunOutcome; liveState: string | undefined }
  /** Cancelled from the dashboard; `refirePending` when it was a restart (a fire is queued). */
  | { kind: "cancelled"; refirePending: boolean }
  /** Gene itself threw while setting up or winding down the run. */
  | { kind: "crashed"; error: string }
  /** The repo couldn't be brought up to date, so the agent never started. */
  | { kind: "branch-sync-failed"; reason: string };

export type EndingPlan = {
  /** The state to move the ticket to; null leaves it where it is. */
  moveTo: string | null;
  /** A comment Gene posts on the ticket, when the ending needs explaining. */
  comment?: string;
  lastResult: "ok" | "incomplete" | "blocked" | "cancelled" | "error";
  /** Activity-log detail. */
  detail: string;
};

/** Why a run didn't finish, or null when it did. */
const incompleteReason = (result: RunOutcome): string | null => {
  if (result.authFailure) return "the Claude CLI on the Gene host isn't logged in (run `claude /login` there)";
  if (result.transientFailure) return "my connection to the model API dropped mid-run";
  if (result.exitCode !== 0) return `the agent exited with code ${result.exitCode}`;
  if (!result.sawSuccessResult) return "the agent stopped without producing a final result";
  return null;
};

const didNotFinish = (why: string): string =>
  `⚠ This run didn't finish: ${why}.\n\n` +
  `The program is back in ${env.TRIGGER_STATE}. Its next trigger runs it again, or press \`g\` on it in Gene to run it now.`;

/**
 * Where a program goes when a run ends. A program at rest is always in the trigger
 * state (Todo — "activated"), so every ending returns there except the two that need a
 * human: the agent parking the run in Blocked to ask something, and a branch that
 * can't be synced (re-firing would only fail again). A cancel for a restart stays
 * ACTIVE for the queued re-fire.
 */
export const planProgramEnding = (ending: ProgramEnding): EndingPlan => {
  const rest = env.TRIGGER_STATE;
  switch (ending.kind) {
    case "cancelled":
      return ending.refirePending
        ? { moveTo: null, lastResult: "cancelled", detail: "cancelled — re-fire queued" }
        : { moveTo: rest, lastResult: "cancelled", detail: `cancelled → ${rest}` };
    case "crashed":
      return {
        moveTo: rest,
        comment: didNotFinish(`Gene hit an error — \`${ending.error.slice(0, 300)}\``),
        lastResult: "error",
        detail: `error → ${rest}: ${ending.error}`
      };
    case "branch-sync-failed":
      return {
        moveTo: env.BLOCKED_STATE,
        comment:
          `⚠ Not running: couldn't bring the repo up to date before the run — ${ending.reason}\n\n` +
          "Fix the branch (the `## Branch` section, or the repo link) and reply here to retry.",
        lastResult: "blocked",
        detail: `branch sync failed → ${env.BLOCKED_STATE}`
      };
    case "finished": {
      if (ending.liveState === env.BLOCKED_STATE) {
        return { moveTo: null, lastResult: "blocked", detail: `parked in ${env.BLOCKED_STATE}` };
      }
      const why = incompleteReason(ending.result);
      return why === null
        ? { moveTo: rest, lastResult: "ok", detail: `→ ${rest} (ok)` }
        : { moveTo: rest, comment: didNotFinish(why), lastResult: "incomplete", detail: `→ ${rest} (incomplete: ${why})` };
    }
  }
};

// --- Child-ticket detection (observability) -----------------------------------------
export const childTicketIds = (geneIssues: Issue[], parentIdentifier: string): string[] =>
  geneIssues.filter(i => i.parentIdentifier === parentIdentifier).map(i => i.identifier);

export const newChildIdentifiers = (current: string[], alreadyLogged: string[]): string[] => {
  const seen = new Set(alreadyLogged);
  return current.filter(id => !seen.has(id));
};

// --- Detail-view section extraction -------------------------------------------------
export type ProgramSections = { trigger: string; workflow: string; acceptance: string };

const sectionBody = (desc: string, heading: string): string => {
  const text = desc || "";
  // At the start of a line, so a `### Trigger` subheading (in the run notes, say) never
  // reads as the `## Trigger` section.
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}`, "m").exec(text);
  if (!match) return "";
  const rest = text.slice(match.index + heading.length);
  const next = rest.search(/\n##\s/);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
};

export const extractProgramSections = (description: string): ProgramSections => ({
  trigger: sectionBody(description, "## Trigger"),
  workflow: sectionBody(description, "## Workflow"),
  acceptance: sectionBody(description, "## Acceptance criteria")
});

// --- Run notes ----------------------------------------------------------------------
/** The description section a program run keeps its memory in between runs. */
export const RUN_NOTES_HEADING = "## Run notes";
const RUN_NOTES_LINE = /^##[ \t]+Run notes[ \t]*$/im;

/**
 * The description with its `## Run notes` section replaced by `notes` (appended when the
 * section is missing). Only that section changes. Headings inside the notes are demoted
 * to `###`, so they can't end the section early or pose as a program section.
 */
export const replaceRunNotes = (description: string, notes: string): string => {
  const body = notes.trim().replace(/^#{1,2}(?=\s)/gm, "###");
  const section = `${RUN_NOTES_HEADING}\n\n${body}\n`;
  const match = RUN_NOTES_LINE.exec(description);
  if (!match) {
    const head = description.trimEnd();
    return head ? `${head}\n\n${section}` : section;
  }
  const before = description.slice(0, match.index);
  const rest = description.slice(match.index + match[0].length);
  const next = rest.search(/^#{1,2}\s/m);
  return next === -1 ? `${before}${section}` : `${before}${section}\n${rest.slice(next)}`;
};

/**
 * The branch a program pins in its `## Branch` section — the first non-empty line,
 * with markdown backticks and an `origin/` prefix stripped. Undefined when the
 * section is absent/empty (the run then uses the repo link's /tree/<ref>/, else the
 * repo's default branch).
 */
export const programBranch = (description: string): string | undefined => {
  const line = sectionBody(description, "## Branch")
    .split("\n")
    .map(l => l.replace(/`/g, "").trim())
    .find(l => l !== "");
  const branch = line?.replace(/^origin\//, "");
  return branch || undefined;
};
