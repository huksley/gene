/**
 * Builds the agent prompt from a tracker issue + its chronological comment
 * transcript. The issue is the conversation — there is no separate state store.
 *
 * Two things the agent MUST get right, encoded as CRITICAL rules below:
 *  - every comment it posts has to carry the agent marker, or the daemon will
 *    mistake Gene's own comment for a fresh human reply and loop;
 *  - every run ends in exactly one terminal state — Blocked (waiting on a human)
 *    or In Review (a change request is open) — never both, never neither.
 */

import { env } from "./config.ts";
import { parseDirective } from "./directives.ts";
import { tracker } from "./tracker/index.ts";
import type { Comment, Issue } from "./tracker/index.ts";
import type { ChangeRequestContext, Forge } from "./forge/index.ts";
import type { ReviewContext } from "./review.ts";

export type PromptIntent =
  | "start-processing"
  | "resume-from-block"
  | "handle-user-feedback"
  | "address-review"
  | "continue-draft";

export type PromptInputs = {
  issue: Issue;
  comments: Comment[];
  worktreePath: string;
  baseBranch: string;
  intent: PromptIntent;
  attachmentRelativePaths: string[];
  commitsBehind: number;
  forge: Forge;
  /** Branch actually checked out in the worktree (the issue's, or a continued CR's). */
  workBranch: string;
  /** "host/repoPath" of the resolved target repo, for the prompt header. */
  repoLabel: string;
  /** Monorepo subdirectory to scope work to, if the issue link pinned one. */
  subdir?: string;
  /** Forge review state (failing CI / new comments), present only for address-review. */
  reviewContext?: ReviewContext;
};

const formatTimestamp = (isoDate: string): string => {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime())
    ? isoDate
    : date.toISOString().replace("T", " ").slice(0, 16);
};

/** Strip the marker so the transcript reads cleanly. */
const cleanBody = (body: string): string => body.split(env.AGENT_MARKER).join("").trim();

const formatComment = (comment: Comment): string => {
  const author = comment.isAgent ? "🤖 Gene" : `👤 ${comment.authorName ?? "user"}`;
  return `[${formatTimestamp(comment.createdAt)}] ${author}:\n${cleanBody(comment.body)}`;
};

const formatTranscript = (comments: Comment[]): string =>
  comments.length === 0 ? "(no comments yet)" : comments.map(formatComment).join("\n\n");

const detectDirectives = (comments: Comment[]): string => {
  const userComments = comments.filter(comment => !comment.isAgent);
  if (userComments.length === 0) {
    return "(none — no user comments yet)";
  }
  const latest = userComments[userComments.length - 1]!;
  const directive = parseDirective(latest.body);
  if (!directive) {
    return "(none in latest user comment — interpret intent from prose)";
  }
  return `Latest user comment contains directive: \`${env.COMMAND_BASE} ${directive.command}${directive.argument ? ` ${directive.argument}` : ""
    }\``;
};

/**
 * Draft mode (GENE_DRAFT_CHANGE_REQUEST): Gene opens change requests as drafts and
 * never marks them ready — a human reviews, marks ready, and merges. Off by default.
 */
const DRAFT_MODE = env.DRAFT_CHANGE_REQUEST;

const intentInstructions: Record<PromptIntent, string> = {
  "start-processing":
    "This issue just entered the Gene queue (Todo). Read the description carefully. " +
    "If the scope is small and unambiguous (typo fix, single-line removal, isolated copy change), " +
    "you may execute directly. Otherwise, propose a plan first and exit, waiting for the user's " +
    `approval via a \`${env.COMMAND_BASE} approve\` directive or a free-form 'go ahead' / 'yes' reply.`,
  "resume-from-block":
    "The issue was previously Blocked — you asked a clarifying question or proposed a plan and the " +
    "user has now replied. Read the latest user comment, decide whether you have enough to proceed, " +
    "and either execute the change, propose a refined plan, or ask one more focused question.",
  "handle-user-feedback":
    "The user has commented while you were working (or after you finished). They may be redirecting " +
    "you, requesting a change, or approving prior work. Read the latest comment, identify what they " +
    "want, and respond accordingly.",
  "address-review":
    "Your change request is open and under review, and there's new review feedback and/or failing CI " +
    "(see the section below). Make the fixes on your EXISTING branch and push so CI re-runs; reply to the " +
    "reviewer(s) on the change request itself; then put the issue back in the review state. Do NOT open a " +
    "second change request — update the one that's already open. If a comment raises something you genuinely " +
    "can't resolve, ask back (comment on the issue) and move to the blocked state instead.",
  "continue-draft":
    "A change request is ALREADY attached to this issue (a human or a previous run opened it — see the " +
    "section below) and its branch is already checked out. Do NOT start over and do NOT open a second one. " +
    "First understand where it stands: run `git log " +
    "--oneline` and review the diff against the base branch, then read the review comments and CI result " +
    "below. Then CONTINUE the work — address failing CI and reviewer feedback, and finish whatever the " +
    "change request is still missing relative to the issue. " +
    (DRAFT_MODE
      ? "When it's complete and CI is green, LEAVE it as a draft — a human marks it ready for review and " +
      "merges — and move the issue to the review state. "
      : "When it's complete and CI is green, mark it ready for review (un-draft it) and move the issue to " +
      "the review state. ") +
    "If you're blocked or need a decision, comment and move to the blocked state instead."
};

const renderScope = (subdir: string | undefined): string => {
  if (!subdir) {
    return "";
  }
  return [
    "",
    "# Working scope (monorepo)",
    "",
    `This repo is a monorepo; this issue targets the **\`${subdir}\`** subdirectory.`,
    `Scope all changes to \`${subdir}/\` within the worktree unless a change strictly outside it`,
    "is required — and call that out in your comment if so. Run typecheck/lint/tests from that",
    "subdirectory's own package (where its config lives), not the repo root.",
    ""
  ].join("\n");
};

const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The forge CLI command to mark a change request ready for review (un-draft). */
const readyCommand = (forge: Forge, iid: string): string =>
  forge.name === "github" ? `gh pr ready ${iid}` : `glab mr update ${iid} --ready`;

/** The draft→ready guidance, conditional on draft mode (in draft mode a human readies). */
const draftHandling = (forge: Forge, iid: string): string =>
  DRAFT_MODE
    ? "Keep it as a **draft** — a human will mark it ready for review and merge; do NOT un-draft it."
    : `When the work is complete and CI is green, mark it ready for review: \`${readyCommand(forge, iid)}\`.`;

const renderReviewContext = (rc: ReviewContext | undefined, forge: Forge): string => {
  if (!rc) {
    return "";
  }
  const term = capitalize(rc.crTerm);
  const bullets = [
    `- ${term}: ${rc.crUrl}`,
    `- CI: **${rc.ci.status}**${rc.ci.detail ? ` — ${rc.ci.detail}` : ""}${rc.ci.url ? ` (${rc.ci.url})` : ""}`
  ];
  if (rc.ci.status === "failed") {
    bullets.push(
      "- Inspect the failing pipeline/checks to see the actual errors — open the CI URL above" +
      (forge.name === "github" ? " or run `gh run view` / `gh pr checks`." : " or run `glab ci view`.")
    );
  }
  if (rc.isDraft) {
    bullets.push(`- This ${rc.crTerm} is a **draft**. ${draftHandling(forge, rc.iid)}`);
  }
  const comments =
    rc.newComments.length === 0
      ? "(no new review comments — continue from the change request's current state and the CI result above)"
      : rc.newComments
        .map(c => `[${formatTimestamp(c.createdAt)}] 👤 ${c.author}:\n${cleanBody(c.body)}`)
        .join("\n\n");
  return [
    "",
    `# ${term} to continue — address this`,
    "",
    `Your open ${rc.crTerm} already exists; do NOT open another. Push fixes to the same branch (already checked out).`,
    "",
    ...bullets,
    "",
    "Review feedback to address (new since you last acted):",
    "",
    comments,
    ""
  ].join("\n");
};

/**
 * Scope-sizing + planning protocol. For non-trivial cards the agent plans (brainstorming →
 * writing-plans) before executing, then picks Shape A (one cohesive change request) or, for
 * top-level cards with truly independent subtasks, Shape B (split into subcards). A card that
 * is itself a subcard (`issue.parentIdentifier` set) may plan but never spawn further subcards.
 */
const renderScopeSizing = (issue: Issue): string => {
  const isSubcard = Boolean(issue.parentIdentifier);
  const lines = [
    "# Scope sizing — read this BEFORE picking an outcome",
    "",
    "Most cards are small (one bug, one screen, one copy change) — handle those directly via the",
    "outcomes below. For **non-trivial scope**, plan first. A card is non-trivial when ANY holds:",
    "- 4 or more items under `## Acceptance criteria`",
    "- description longer than ~600 characters",
    '- title/description contains: "refactor", "migrate", "redesign", "introduce", "rewrite",',
    '  "add feature", "build a", "implement a", "overhaul"',
    "- the work would plausibly touch 5+ files (excluding tests)",
    "",
    "For non-trivial scope, do NOT jump straight to editing. Follow the **planning protocol**:",
    "1. Use the `superpowers:brainstorming` skill to clarify intent and surface hidden constraints.",
    "2. Use `superpowers:writing-plans` to produce a structured, checkbox plan.",
    "3. Pick the **shape** of the work and complete the matching outcome.",
    "",
    "## Shape A — one cohesive change request (most non-trivial cards)",
    "",
    `Steps are internal (files, sequential edits). Post the markdown-checkbox plan as a comment, move to`,
    `"${env.BLOCKED_STATE}", and exit. On approval (a \`${env.COMMAND_BASE} approve\` directive or a free-form`,
    '"go ahead" / "yes" reply) you resume and use `superpowers:executing-plans` to work the checklist on ONE',
    "branch → ONE change request (outcome 3). Independently parallelizable steps may use",
    "`superpowers:dispatching-parallel-agents`, but all output still lands on one branch and one change request."
  ];

  if (isSubcard) {
    lines.push(
      "",
      "## Shape B — NOT available here",
      "",
      "This card is a **subcard** (its description/parent links to a parent card). Subcards may plan, but",
      "their output is ALWAYS one of outcomes 1–4 — never split into further subcards. If the scope turns out",
      "too big, prefer a Shape A plan inside this card's single change request."
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    "## Shape B — independently shippable subcards (rare; only when truly independent)",
    "",
    "The plan reveals 3–6 subtasks that are each reviewable and mergeable on their own. The right output is",
    "**N subcards, each running through the normal pipeline** — NOT one giant change request. When Shape B",
    "applies, follow outcome 5 below.",
    "",
    tracker.subcardSnippet(issue)
  );
  return lines.join("\n");
};

const renderAttachments = (paths: string[]): string => {
  if (paths.length === 0) {
    return "(none)";
  }
  return paths
    .map(p => `- \`${p}\` — use the Read tool to open; Claude vision handles images natively.`)
    .join("\n");
};

const renderDriftAdvice = (n: number, baseBranch: string): string => {
  const upstream = `origin/${baseBranch}`;
  if (n === 0) {
    return `Your branch is up-to-date with \`${upstream}\` — no drift.`;
  }
  if (n <= 5) {
    return [
      `Your branch is **${n} commit${n === 1 ? "" : "s"} behind** \`${upstream}\` (minor drift).`,
      `Run \`git log HEAD..${upstream} --stat\` before editing files that overlap.`,
      "Usually safe to proceed without syncing; only sync if you see overlap."
    ].join(" ");
  }
  return [
    `**Significant drift: ${n} commits behind \`${upstream}\`.**`,
    "Before doing any code work, sync the branch first. **Use rebase by default** —",
    "it keeps the change-request diff clean (only your actual changes show). Use merge only as a fallback",
    "when rebase fails or the branch has been actively reviewed by humans (force-push would lose review history).",
    "",
    "Recommended procedure (run from the worktree):",
    `1. \`git log HEAD..${upstream} --stat\` — see what landed upstream`,
    `2. \`git rebase ${upstream}\` — attempt the rebase`,
    "3. **If rebase succeeds cleanly:** proceed with your work; when you next push, use",
    "   `git push --force-with-lease` (safe force-push that refuses if remote moved unexpectedly).",
    "   Mention the rebase in the next comment so reviewers know history was rewritten.",
    `4. **If rebase has conflicts:** \`git rebase --abort\`, then try \`git merge ${upstream}\``,
    "   (no force-push needed). Commit the merge.",
    "5. **If merge also conflicts:** abort it, post a comment listing the conflicting files",
    '   with the suggestion "please rebase manually and re-trigger", move the issue to Blocked, and exit.'
  ].join(" ");
};

export const buildPrompt = (inputs: PromptInputs): string => {
  const {
    issue,
    comments,
    worktreePath,
    baseBranch,
    intent,
    attachmentRelativePaths,
    commitsBehind,
    forge,
    workBranch,
    repoLabel,
    subdir,
    reviewContext
  } = inputs;

  // The branch actually checked out: the issue's own auto-link branch for fresh
  // work, or a continued change request's source branch (which may be human-named).
  const branch = workBranch;
  const onIssueBranch = branch === issue.branchName;

  const ctx: ChangeRequestContext = {
    issueId: issue.identifier,
    issueUrl: issue.url,
    branch,
    baseBranch
  };
  const cr = forge.changeRequestTerm; // "merge request" / "pull request"
  const project = issue.projectName ?? issue.teamName ?? "the project";
  const branchNote = onIssueBranch
    ? `this is ${issue.identifier}'s branch — push your work here; the ${cr} you open from it is the deliverable`
    : `this is the existing ${cr}'s source branch — keep pushing to it so the open ${cr} updates`;

  return `You are **Gene**, the autonomous code agent for ${project}.

You are processing a single ${tracker.name} issue. The issue description and the comment transcript below
form the complete conversation between you and the human user. You have NO other memory — read everything
carefully before deciding.

# Repository context

- Repository: \`${repoLabel}\` (forge: ${forge.name})
- Worktree (your working directory, the repo root): \`${worktreePath}\`
- Base branch: \`${baseBranch}\`
- Your branch (already checked out): \`${branch}\` — ${branchNote}. Do NOT create a new branch.
- Reference the issue URL \`${issue.url}\` in the commit body and the ${cr} description (so the work links back to ${issue.identifier}).
${renderScope(subdir)}
# Issue

- **ID:** ${issue.identifier}
- **URL:** ${issue.url}
- **Title:** ${issue.title}
- **State:** ${issue.stateName}
- **Team:** ${issue.teamName} (${issue.teamKey})
- **Project:** ${issue.projectName ?? "(none)"}

## Description

${issue.description.trim() || "(empty)"}

# Attachments staged in your worktree (paths relative to cwd)

${renderAttachments(attachmentRelativePaths)}

# Drift from upstream (\`origin/${baseBranch}\`)

${renderDriftAdvice(commitsBehind, baseBranch)}

# Conversation transcript (chronological)

${formatTranscript(comments)}

# Directives detected

${detectDirectives(comments)}
${renderReviewContext(reviewContext, forge)}
# This invocation's intent

\`${intent}\` — ${intentInstructions[intent]}

${tracker.writeBackSnippet(issue)}

# How to open the ${cr}

${forge.promptSnippet(ctx)}

${renderScopeSizing(issue)}

# Your task — pick ONE outcome

1. **Ask a clarifying question** — post one comment with the question, move the issue to
   **"${env.BLOCKED_STATE}"**, then exit. Use this only when ambiguity would lead to materially wrong code.
2. **Propose a plan** — for non-trivial scope (Shape A), post the markdown-checkbox plan as a comment, move
   the issue to **"${env.BLOCKED_STATE}"**, then exit. Wait for user approval before executing.
3. **Execute code changes** — edit files on your branch, run typecheck + lint, commit, \`git push -u origin
   "${branch}"\`, open the ${cr} (above), post a comment with the ${cr} link, then move the issue to
   **"${env.REVIEW_STATE}"**. Do NOT merge — human merge is the final gate.
4. **Acknowledge and adjust** — when the user redirected you, post an acknowledgement comment describing
   the revised approach, then either execute (outcome 3) or propose (outcome 2).${issue.parentIdentifier
      ? ""
      : `
5. **Split into subcards** — for Shape B (truly independent subtasks), create the subcards per the
   "How to split into subcards" instructions above, post a summary comment, move the issue to
   **"${env.BLOCKED_STATE}"**, then exit. The daemon moves this parent to Done automatically once every
   subcard is done.`}

# Hard rules

- **Comment marker (CRITICAL):** end EVERY issue comment you post with this exact line on its own,
  so the daemon recognises the comment as yours and does not treat it as a new human reply:

  \`\`\`
  ${env.AGENT_MARKER}
  \`\`\`

  A comment missing this marker will make the daemon loop. No exceptions.
- **Marker on ${cr} comments too (CRITICAL):** when you reply on the ${forge.name} ${cr} itself (not the issue),
  end that comment with the same \`${env.AGENT_MARKER}\` line. The In-Review watchdog reads ${cr} comments to
  spot new *human* review feedback; an unmarked reply of yours looks like fresh feedback and re-dispatches you
  in a loop.
- **Terminal state (CRITICAL):** every run MUST end with the issue in exactly one of these states:
  - **"${env.BLOCKED_STATE}"** — you posted a question, a plan, or a split-into-subcards summary and are waiting on the user.
  - **"${env.REVIEW_STATE}"** — you opened a ${cr}.
  If you exit without opening a ${cr}, you MUST move the issue to "${env.BLOCKED_STATE}". Never both, never neither.
- **No nested subcards:** splitting into subcards (outcome 5) is only for top-level cards. ${issue.parentIdentifier
      ? "This card IS a subcard — outcome 5 is not available to you; finish via outcomes 1–4."
      : "If a subtask is too big, prefer a Shape A plan inside its own subcard rather than recursing."}
- Never merge the ${cr}. Never push to the \`${baseBranch}\` branch directly.
- Do NOT touch the issue's labels — the \`${env.LABEL}\` label is Gene's ownership tag and the daemon manages it.
- Stay inside the worktree at \`${worktreePath}\`. Do not edit files elsewhere.
- **Resuming an interrupted run (idempotency):** a previous attempt may have been cut short by a transient
  error, so treat your actions as resumable, not fresh. Before starting, run \`git status\` and
  \`git log --oneline ${baseBranch}..HEAD\` in the worktree and continue from any partial work (reconciled
  with the transcript) instead of redoing it. Before opening a ${cr}, check whether one already exists for
  \`${branch}\` and update that one rather than creating a duplicate.
- Run \`npx tsc --noEmit\` and the project linter on changed files before committing.
- If pre-commit hooks fail, fix and create a NEW commit (never \`--amend\` pushed commits).
- After completing exactly one of the four outcomes above, EXIT. Do not loop, do not poll, do not await
  further input — the daemon will dispatch you again when something changes on the issue.
`;
};
