/**
 * Pluggable issue-tracker layer. Gene drives one tracker per run (GENE_TRACKER);
 * everything downstream talks to the neutral `Issue` / `Comment` / `Attachment`
 * types and the `Tracker` interface, never a backend directly — exactly how
 * `src/forge/` abstracts GitLab vs GitHub. Today: Linear and Trello.
 *
 * The tracker is a process-wide singleton (`tracker`), chosen at startup — unlike
 * the forge, which is selected per-issue from the issue's repo link.
 */

import { env } from "../config.ts";
import type { AttachmentRef } from "../attachment-refs.ts";
import { LinearTracker } from "./linear.ts";
import { TrelloTracker } from "./trello.ts";

/** A tracker-neutral issue (a Linear issue / a Trello card). */
export type Issue = {
  /** Backend id for sub-queries / CLI calls (Linear uuid / Trello card id). */
  id: string;
  /** Short human key — drives the lock, worktree dir, and branch base (CLOUD-1094 / Trello shortLink). */
  identifier: string;
  title: string;
  description: string;
  url: string;
  /** Branch the worktree uses — Linear's auto-link branch / a synthesized `gene/<shortLink>`. */
  branchName: string;
  /** Lifecycle state name — a Linear workflow state / a Trello list name. */
  stateName: string;
  updatedAt: string;
  /** Display name(s) of the assignee(s), for logging. */
  assigneeName: string | null;
  /** True when the issue is assigned to the authenticated tracker user (the "me" filter). */
  assigneeIsMe: boolean;
  /** Value a specific (non-"me") ASSIGNEE is matched against — Linear: email; Trello: csv of usernames. */
  assigneeMatch: string | null;
  /** Team/board context — also used for per-team default-repo routing (repos.ts). */
  teamKey: string;
  teamName: string;
  projectName: string | null;
  /**
   * Identifier of this issue's parent when it is a subcard (Shape B), else undefined.
   * Populated natively per backend — Linear's sub-issue `parent`, Trello's `Parent: <url>`
   * description marker — so the daemon (src/subcards.ts) can group children uniformly.
   */
  parentIdentifier?: string;
};

/** A tracker-neutral comment. `isAgent` is detected via the agent marker, uniformly across backends. */
export type Comment = {
  id: string;
  body: string;
  createdAt: string;
  authorName: string | null;
  isAgent: boolean;
};

/** A link/attachment on an issue (the forge integration's MR/PR link, an image, a doc…). */
export type Attachment = {
  title: string | null;
  url: string;
  /** Integration source, e.g. "gitlab"/"github" (informational; we parse the URL). */
  sourceType: string | null;
};

export interface Tracker {
  /** Backend name, "linear" / "trello" — for logging and the prompt. */
  readonly name: string;

  /** All issues carrying the Gene label, any state (the caller buckets by state). */
  listIssues(): Promise<Issue[]>;
  /** Chronologically-sorted comments for an issue. */
  getComments(issue: Issue): Promise<Comment[]>;
  /** Links/attachments on an issue (used for MR/PR discovery in review.ts). */
  getAttachments(issue: Issue): Promise<Attachment[]>;

  /** Distinct stageable attachment refs (images + text/docs) referenced by the issue/comments. */
  collectAttachmentUrls(issue: Issue, comments: Comment[]): Promise<AttachmentRef[]>;
  /** Authed download of one attachment/image URL; null on any failure (best-effort). */
  fetchAttachment(url: string): Promise<Buffer | null>;

  /** Post a comment as Gene (marker appended). Honours GENE_DRY_RUN (log-only). */
  postComment(issue: Issue, body: string): Promise<void>;
  /** Move an issue to a lifecycle state by name. Honours GENE_DRY_RUN (log-only). */
  moveToState(issue: Issue, stateName: string): Promise<void>;
  /**
   * Drop the Gene ownership label (env.LABEL) from an issue so the daemon stops
   * managing it — the inverse of the label filter listIssues() applies. Resolves to
   * `true` when the issue no longer carries the label (removed now, or wasn't there)
   * and `false` when the removal failed — best-effort, so a backend error is warned
   * and folded into `false` rather than thrown, letting the caller keep the row. A
   * dry-run is a no-op that resolves `true`. Honours GENE_DRY_RUN (log-only).
   */
  removeGeneLabel(issue: Issue): Promise<boolean>;

  /** Whether an issue is assigned to the user Gene works for (env.ASSIGNEE). */
  isAssignedToOwner(issue: Issue): boolean;
  /** Human-readable label for env.ASSIGNEE, for logging ("you"/"anyone"/the value). */
  ownerLabel(): string;

  /** The prompt block telling the AGENT how to comment / move state via this backend's CLI. */
  writeBackSnippet(issue: Issue): string;
  /**
   * The prompt block telling the AGENT how to CREATE a subcard (Shape B) that links back to
   * `issue` as its parent and enters the normal pipeline (carries the Gene label, lands in the
   * trigger state, assigned to the owner). Backends resolve their own ids/native parent link.
   */
  subcardSnippet(issue: Issue): string;
  /** Extra `--allowedTools` entries the agent needs for this backend (e.g. `Bash(trello *)`). */
  allowedTools(): string[];

  /**
   * Optionally start reacting to backend activity in real time (a webhook), so the
   * daemon can wake before the next poll. Calls `onActivity` on each relevant event
   * and resolves to a stop function. A poll-only tracker omits this entirely.
   */
  startWatch?(onActivity: () => void): Promise<() => void>;
}

/** Construct the issue tracker for a backend name (mirrors selectForge). */
export const selectTracker = (name: "linear" | "trello"): Tracker =>
  name === "trello" ? new TrelloTracker() : new LinearTracker();

/** The process-wide issue tracker, chosen by GENE_TRACKER at startup. */
export const tracker: Tracker = selectTracker(env.TRACKER);

/**
 * Look up a single Gene issue by its human identifier — for `reset.ts`, which only
 * has the identifier string. Reuses listIssues (Gene issues always carry the
 * label), so it returns null for an unknown / non-Gene identifier.
 */
export const findIssue = async (identifier: string): Promise<Issue | null> =>
  (await tracker.listIssues()).find(i => i.identifier === identifier) ?? null;
