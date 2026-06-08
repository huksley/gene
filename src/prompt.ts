/**
 * Builds the agent prompt from a Linear issue + its chronological comment
 * transcript. The issue is the conversation — there is no separate state store.
 *
 * Two things the agent MUST get right, encoded as CRITICAL rules below:
 *  - every Linear comment it posts has to carry the agent marker, or the
 *    daemon will mistake Gene's own comment for a fresh human reply and loop;
 *  - every run ends in exactly one terminal state — Blocked (waiting on a human)
 *    or In Review (a change request is open) — never both, never neither.
 */

import { env } from "./config.ts";
import { parseDirective } from "./directives.ts";
import type { LinearComment, LinearIssue } from "./linear.ts";
import type { ChangeRequestContext, Forge } from "./forge/index.ts";
import type { ReviewContext } from "./review.ts";

export type PromptIntent =
  | "start-processing"
  | "resume-from-block"
  | "handle-user-feedback"
  | "address-review";

export type PromptInputs = {
  issue: LinearIssue;
  comments: LinearComment[];
  worktreePath: string;
  baseBranch: string;
  intent: PromptIntent;
  attachmentRelativePaths: string[];
  commitsBehind: number;
  forge: Forge;
  /** "host/repoPath" of the resolved target repo, for the prompt header. */
  repoLabel: string;
  /** Monorepo subdirectory to scope work to, if the issue link pinned one. */
  subdir?: string;
  /** Forge review state (failing CI / new comments), present only for address-review. */
  reviewContext?: ReviewContext;
};

const workspaceFlag = (): string => (env.LINEAR_WORKSPACE ? ` -w "${env.LINEAR_WORKSPACE}"` : "");

const formatTimestamp = (isoDate: string): string => {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime())
    ? isoDate
    : date.toISOString().replace("T", " ").slice(0, 16);
};

/** Strip the marker so the transcript reads cleanly. */
const cleanBody = (body: string): string => body.split(env.AGENT_MARKER).join("").trim();

const formatComment = (comment: LinearComment): string => {
  const author = comment.isAgent ? "🤖 Gene" : `👤 ${comment.authorName ?? "user"}`;
  return `[${formatTimestamp(comment.createdAt)}] ${author}:\n${cleanBody(comment.body)}`;
};

const formatTranscript = (comments: LinearComment[]): string =>
  comments.length === 0 ? "(no comments yet)" : comments.map(formatComment).join("\n\n");

const detectDirectives = (comments: LinearComment[]): string => {
  const userComments = comments.filter(comment => !comment.isAgent);
  if (userComments.length === 0) {
    return "(none — no user comments yet)";
  }
  const latest = userComments[userComments.length - 1]!;
  const directive = parseDirective(latest.body);
  if (!directive) {
    return "(none in latest user comment — interpret intent from prose)";
  }
  return `Latest user comment contains directive: \`@gene ${directive.command}${
    directive.argument ? ` ${directive.argument}` : ""
  }\``;
};

const intentInstructions: Record<PromptIntent, string> = {
  "start-processing":
    "This issue just entered the Gene queue (Todo). Read the description carefully. " +
    "If the scope is small and unambiguous (typo fix, single-line removal, isolated copy change), " +
    "you may execute directly. Otherwise, propose a plan first and exit, waiting for the user's " +
    "approval via a `@gene approve` directive or a free-form 'go ahead' / 'yes' reply.",
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
    "can't resolve, ask back (on Linear) and move to the blocked state instead."
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

const renderReviewContext = (rc: ReviewContext | undefined): string => {
  if (!rc) {
    return "";
  }
  const term = capitalize(rc.crTerm);
  const ciLine = `- CI: **${rc.ci.status}**${rc.ci.detail ? ` — ${rc.ci.detail}` : ""}${
    rc.ci.url ? ` (${rc.ci.url})` : ""
  }`;
  const comments =
    rc.newComments.length === 0
      ? "(no new review comments — this was triggered by the CI result above)"
      : rc.newComments
          .map(c => `[${formatTimestamp(c.createdAt)}] 👤 ${c.author}:\n${cleanBody(c.body)}`)
          .join("\n\n");
  return [
    "",
    `# ${term} under review — address this`,
    "",
    `Your open ${rc.crTerm} already exists; do NOT open another. Push fixes to the same branch.`,
    "",
    `- ${term}: ${rc.crUrl}`,
    ciLine,
    "",
    "New review feedback since you last acted:",
    "",
    comments,
    ""
  ].join("\n");
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
    repoLabel,
    subdir,
    reviewContext
  } = inputs;

  const ctx: ChangeRequestContext = {
    issueId: issue.identifier,
    issueUrl: issue.url,
    branch: issue.branchName,
    baseBranch
  };
  const cr = forge.changeRequestTerm; // "merge request" / "pull request"
  const ws = workspaceFlag();
  const project = issue.projectName ?? issue.teamName ?? "the project";

  return `You are **Gene**, the autonomous code agent for ${project}.

You are processing a single Linear issue. The issue description and the comment transcript below form
the complete conversation between you and the human user. You have NO other memory — read everything
carefully before deciding.

# Repository context

- Repository: \`${repoLabel}\` (forge: ${forge.name})
- Worktree (your working directory, the repo root): \`${worktreePath}\`
- Base branch: \`${baseBranch}\`
- Your branch (already checked out): \`${issue.branchName}\` — this is Linear's auto-link branch, so a
  ${cr} from it will link back to ${issue.identifier} automatically. Do NOT create a new branch.
- Reference \`Linear: ${issue.url}\` in the commit body and the ${cr} description.
${renderScope(subdir)}
# Linear issue

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
${renderReviewContext(reviewContext)}
# This invocation's intent

\`${intent}\` — ${intentInstructions[intent]}

# How to write back to Linear (use the \`linear\` CLI)

- **Comment:** write the body to a temp file and run
  \`linear issue comment add ${issue.identifier} --body-file <file>${ws}\`
  (or \`--body "<text>"\` for a one-liner). Keep each comment to one focused message.
- **Move state:** \`linear issue update ${issue.identifier} --state "<State>"${ws}\`.
  Terminal states for you are **"${env.BLOCKED_STATE}"** and **"${env.REVIEW_STATE}"** (see outcomes).

# How to open the ${cr}

${forge.promptSnippet(ctx)}

# Your task — pick ONE outcome

1. **Ask a clarifying question** — post one comment with the question, move the issue to
   **"${env.BLOCKED_STATE}"**, then exit. Use this only when ambiguity would lead to materially wrong code.
2. **Propose a plan** — post a comment outlining files to change + approach + estimated scope, move the
   issue to **"${env.BLOCKED_STATE}"**, then exit. Wait for user approval before executing.
3. **Execute code changes** — edit files on your branch, run typecheck + lint, commit, \`git push -u origin
   "${issue.branchName}"\`, open the ${cr} (above), post a comment with the ${cr} link, then move the issue to
   **"${env.REVIEW_STATE}"**. Do NOT merge — human merge is the final gate.
4. **Acknowledge and adjust** — when the user redirected you, post an acknowledgement comment describing
   the revised approach, then either execute (outcome 3) or propose (outcome 2).

# Hard rules

- **Comment marker (CRITICAL):** end EVERY Linear comment you post with this exact line on its own,
  so the daemon recognises the comment as yours and does not treat it as a new human reply:

  \`\`\`
  ${env.AGENT_MARKER}
  \`\`\`

  A comment missing this marker will make the daemon loop. No exceptions.
- **Marker on ${cr} comments too (CRITICAL):** when you reply on the ${forge.name} ${cr} itself (not Linear),
  end that comment with the same \`${env.AGENT_MARKER}\` line. The In-Review watchdog reads ${cr} comments to
  spot new *human* review feedback; an unmarked reply of yours looks like fresh feedback and re-dispatches you
  in a loop.
- **Terminal state (CRITICAL):** every run MUST end with the issue in exactly one of these states:
  - **"${env.BLOCKED_STATE}"** — you posted a question or plan and are waiting on the user.
  - **"${env.REVIEW_STATE}"** — you opened a ${cr}.
  If you exit without opening a ${cr}, you MUST move the issue to "${env.BLOCKED_STATE}". Never both, never neither.
- Never merge the ${cr}. Never push to the \`${baseBranch}\` branch directly.
- Do NOT touch the issue's labels — the \`${env.GENE_LABEL}\` label is Gene's ownership tag and the daemon manages it.
- Stay inside the worktree at \`${worktreePath}\`. Do not edit files elsewhere.
- **Resuming an interrupted run (idempotency):** a previous attempt may have been cut short by a transient
  error, so treat your actions as resumable, not fresh. Before starting, run \`git status\` and
  \`git log --oneline ${baseBranch}..HEAD\` in the worktree and continue from any partial work (reconciled
  with the transcript) instead of redoing it. Before opening a ${cr}, check whether one already exists for
  \`${issue.branchName}\` and update that one rather than creating a duplicate.
- Run \`npx tsc --noEmit\` and the project linter on changed files before committing.
- If pre-commit hooks fail, fix and create a NEW commit (never \`--amend\` pushed commits).
- After completing exactly one of the four outcomes above, EXIT. Do not loop, do not poll, do not await
  further input — the daemon will dispatch you again when something changes on the issue.
`;
};
