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
  | { kind: "stop" };

// --- Manual-fire queue (Phase 1: manual only; triggers enqueue here in Phase 2) ----
const pendingFires = new Map<string, ProgramSource>();

/** Enqueue a fire for a program (idempotent per identifier). */
export const fireProgram = (identifier: string, source: ProgramSource = "manual"): void => {
  pendingFires.set(identifier.toLowerCase(), source);
};

export const hasFireRequest = (identifier: string): boolean =>
  pendingFires.has(identifier.toLowerCase());

/** Remove and return a pending fire's source (undefined if none). Consuming it
 *  guarantees exactly one dispatch per request. */
export const takeFireRequest = (identifier: string): ProgramSource | undefined => {
  const key = identifier.toLowerCase();
  const source = pendingFires.get(key);
  if (source !== undefined) pendingFires.delete(key);
  return source;
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

export const decideProgramAction = (
  program: Issue,
  comments: Comment[],
  opts: { firePending: boolean; source?: ProgramSource; runInFlight: boolean }
): ProgramAction => {
  const source = opts.source ?? "manual";
  if (opts.firePending) {
    return opts.runInFlight ? { kind: "restart", source } : { kind: "fire", source };
  }
  if (program.stateName === env.ACTIVE_STATE) {
    // ACTIVE with a live run: leave it. ACTIVE with nothing running locally: the
    // daemon restarted mid-run — resume it (worktree/scratch dir persists).
    if (opts.runInFlight) return { kind: "nothing", reason: "run in progress" };
    return { kind: "resume-interrupted" };
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
  const start = text.indexOf(heading);
  if (start === -1) return "";
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n##\s/);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
};

export const extractProgramSections = (description: string): ProgramSections => ({
  trigger: sectionBody(description, "## Trigger"),
  workflow: sectionBody(description, "## Workflow"),
  acceptance: sectionBody(description, "## Acceptance criteria")
});
