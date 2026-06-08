/**
 * Builds the agent prompt from a Trello card + its chronological comment
 * transcript. The card itself is the conversation — no separate state store.
 */

import { AGENT_MEMBER_ID } from "./config";
import { parseDirective } from "./directives";
import type { TrelloCard, TrelloComment, TrelloMember } from "./trello";

export type PromptInputs = {
  card: TrelloCard;
  comments: TrelloComment[];
  members: Map<string, TrelloMember>;
  worktreePath: string;
  intent: "start-processing" | "resume-from-block" | "handle-user-feedback";
  attachmentRelativePaths: string[];
  commitsBehindOriginDev: number;
};

const formatTimestamp = (isoDate: string): string => {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime())
    ? isoDate
    : date.toISOString().replace("T", " ").slice(0, 16);
};

const formatComment = (comment: TrelloComment, members: Map<string, TrelloMember>): string => {
  const isAgent = comment.idMemberCreator === AGENT_MEMBER_ID;
  const member = members.get(comment.idMemberCreator);
  const author = isAgent ? "🤖 agent" : `👤 ${member?.fullName ?? member?.username ?? "user"}`;
  return `[${formatTimestamp(comment.date)}] ${author}:\n${comment.data.text}`;
};

const formatTranscript = (
  comments: TrelloComment[],
  members: Map<string, TrelloMember>
): string => {
  if (comments.length === 0) {
    return "(no comments yet)";
  }
  return comments.map(comment => formatComment(comment, members)).join("\n\n");
};

const detectDirectives = (comments: TrelloComment[]): string => {
  const userComments = comments.filter(comment => comment.idMemberCreator !== AGENT_MEMBER_ID);
  if (userComments.length === 0) {
    return "(none — no user comments yet)";
  }
  const latest = userComments[userComments.length - 1];
  const directive = parseDirective(latest.data.text);
  if (!directive) {
    return "(none in latest user comment — interpret intent from prose)";
  }
  return `Latest user comment contains directive: \`@claude ${directive.command}${
    directive.argument ? ` ${directive.argument}` : ""
  }\``;
};

const intentInstructions: Record<PromptInputs["intent"], string> = {
  "start-processing":
    "This card just entered the AI Code Assistant queue. Read the description carefully. " +
    "If the scope is small and unambiguous (typo fix, single-line removal, isolated copy change), " +
    "you may execute directly. Otherwise, propose a plan first and exit, waiting for the user's " +
    "approval via a `@claude approve` directive or a free-form 'go ahead' / 'yes' reply.",
  "resume-from-block":
    "The card was previously `ai:blocked` — you asked a clarifying question and the user has now " +
    "replied. Read the latest user comment, decide whether you have enough to proceed, and either " +
    "execute the change, propose a refined plan, or ask one more focused question.",
  "handle-user-feedback":
    "The user has commented while you were working (or after you finished). They may be redirecting " +
    "you, requesting a change, or approving prior work. Read the latest comment, identify what " +
    "they want, and respond accordingly."
};

const renderAttachments = (paths: string[]): string => {
  if (paths.length === 0) {
    return "(none)";
  }
  return paths
    .map(p => `- \`${p}\` — use the Read tool to open; Claude vision handles images natively.`)
    .join("\n");
};

const renderDriftAdvice = (n: number): string => {
  if (n === 0) {
    return "Your branch is up-to-date with `origin/dev` — no drift.";
  }
  if (n <= 5) {
    return [
      `Your branch is **${n} commit${n === 1 ? "" : "s"} behind** \`origin/dev\` (minor drift).`,
      "Run `git log HEAD..origin/dev --stat` before editing files that overlap.",
      "Usually safe to proceed without syncing; only sync if you see overlap."
    ].join(" ");
  }
  return [
    `**Significant drift: ${n} commits behind \`origin/dev\`.**`,
    "Before doing any code work, sync the branch first. **Use rebase by default** —",
    "it keeps the PR diff clean (only your actual changes show). Use merge only as a fallback",
    "when rebase fails or the branch has been actively reviewed by humans (force-push would lose review history).",
    "",
    "Recommended procedure (run from the worktree):",
    "1. `git log HEAD..origin/dev --stat` — see what landed upstream",
    "2. `git rebase origin/dev` — attempt the rebase",
    "3. **If rebase succeeds cleanly:** proceed with your work; when you next push, use",
    "   `git push --force-with-lease` (safe force-push that refuses if remote moved unexpectedly).",
    "   Mention the rebase in the next PR comment so reviewers know history was rewritten.",
    "4. **If rebase has conflicts:** `git rebase --abort`, then try `git merge origin/dev`",
    "   (no force-push needed). Commit the merge.",
    "5. **If merge also conflicts:** abort it, post a comment listing the conflicting files",
    '   with the suggestion "please rebase manually and re-trigger", apply `ai:blocked`, and exit.'
  ].join(" ");
};

export const buildPrompt = (inputs: PromptInputs): string => {
  const {
    card,
    comments,
    members,
    worktreePath,
    intent,
    attachmentRelativePaths,
    commitsBehindOriginDev
  } = inputs;
  const labels = card.idLabels.length > 0 ? card.idLabels.join(", ") : "(none)";

  return `You are the AI Code Assistant for the Welby/Meridian project.

You are processing a single Trello card. The card description and the comment transcript below form
the complete conversation between you and the human user. You have NO other memory — read everything
carefully before deciding.

# Repository context

- Worktree (your working directory): \`${worktreePath}\`
- Base branch: \`dev\`
- Branch naming: \`fix/trello-${card.shortLink}-<slug>\`
- Commit and PR descriptions MUST include the Trello short URL: ${card.shortUrl}

# Trello card

- **Short ID:** ${card.shortLink}
- **URL:** ${card.shortUrl}
- **Title:** ${card.name}
- **Labels (IDs):** ${labels}

## Description

${card.desc.trim() || "(empty)"}

# Attachments staged in your worktree (paths relative to cwd)

${renderAttachments(attachmentRelativePaths)}

# Drift from upstream (\`origin/dev\`)

${renderDriftAdvice(commitsBehindOriginDev)}

# Conversation transcript (chronological)

${formatTranscript(comments, members)}

# Directives detected

${detectDirectives(comments)}

# This invocation's intent

\`${intent}\` — ${intentInstructions[intent]}

# Your task — pick ONE outcome

1. **Ask a clarifying question** — post one Trello comment with the question, apply the \`ai:blocked\`
   label, then exit. Use this only when ambiguity would lead to materially wrong code.
2. **Propose a plan** — post a Trello comment outlining files to change + approach + estimated scope,
   apply the \`ai:blocked\` label, then exit. Wait for user approval before executing.
3. **Execute code changes** — remove the \`ai:blocked\` label if present, create the branch, edit
   files, run typecheck + lint, commit, push, open a PR, comment back on the card with the PR link,
   apply \`ai:done\`, and move the card to the \`Testing\` list. Do NOT merge your own PR —
   human merge is the final gate.
4. **Acknowledge and adjust** — when the user redirected you, post an acknowledgement comment
   describing the revised approach, then either execute (follow outcome 3) or propose (follow
   outcome 2). In all sub-cases, end the run with either \`ai:blocked\` (if you're waiting for
   user input) or \`ai:done\` (if you opened a PR) applied — never both, never neither.

# Hard rules

- **Labeling discipline (CRITICAL):** Every run MUST end with exactly one of these states applied:
  - \`ai:blocked\` — you posted a question or plan and are waiting on the user
  - \`ai:done\` — you opened a PR
  If you exit without opening a PR, you MUST apply \`ai:blocked\`. No exceptions.
- Never merge a PR. Never push to \`main\` or \`dev\` directly.
- Branch off \`dev\`. Reference the Trello short URL in the commit body.
- Stay inside the worktree at \`${worktreePath}\`. Do not edit files elsewhere.
- Run \`npx tsc --noEmit\` and \`npx eslint\` on changed files before committing.
- If pre-commit hooks fail, fix and create a NEW commit (never \`--amend\` pushed commits).
- For Trello updates use the \`mcp__trello__*\` tools — comments must be one focused message.
- After completing exactly one of the four outcomes above, EXIT. Do not loop, do not poll, do not
  await further input — the daemon will dispatch you again when something changes on the card.
`;
};
