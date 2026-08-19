/**
 * Linear tracker. Reads go through `linear api` (raw GraphQL, to filter by label +
 * select exactly the fields we need); writes go through the high-level
 * `linear issue …` commands. Wrapped as `LinearTracker` behind the neutral
 * `Tracker` interface (see ./index.ts) — behaviour is unchanged from the original
 * single-tracker pipeline.
 *
 * Identity: the `linear` CLI posts as the authenticated human user, so we can't
 * tell Gene's own comments from a person's by author. Instead every comment Gene
 * writes carries a marker (env.AGENT_MARKER); `isAgent` keys off that.
 *
 * All write operations honour GENE_DRY_RUN (log instead of mutate).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import logger from "../logger.ts";
import { env } from "../config.ts";
import { buildBranchName, choosePrefix } from "../branch.ts";
import { collectAttachmentRefsFromText, type AttachmentRef } from "../attachment-refs.ts";
import { run, runOrThrow } from "../exec.ts";
import { fetchRetryTimeout } from "../fetch.ts";
import type { Attachment, Comment, Issue, Tracker } from "./index.ts";

type RawIssue = {
  id: string;
  identifier: string;
  title: string | null;
  description: string | null;
  url: string;
  updatedAt: string;
  estimate: number | null;
  labels: { nodes: { name: string }[] } | null;
  state: { name: string; type: string } | null;
  team: { key: string; name: string } | null;
  project: { name: string } | null;
  assignee: { id: string; displayName: string | null; email: string | null; isMe: boolean } | null;
  parent: { identifier: string } | null;
};

type RawComment = {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; displayName: string | null; email: string | null } | null;
};

const workspaceArgs = (): string[] => (env.LINEAR_WORKSPACE ? ["-w", env.LINEAR_WORKSPACE] : []);

/** The ` -w "<workspace>"` flag, as the agent should type it in the prompt snippet. */
const workspaceFlag = (): string => (env.LINEAR_WORKSPACE ? ` -w "${env.LINEAR_WORKSPACE}"` : "");

const oneLine = (value: string, max = 140): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Run a raw GraphQL request through the `linear api` command. */
const api = async <T>(query: string, variables: Record<string, string> = {}): Promise<T> => {
  const args = ["api", query, ...workspaceArgs()];
  for (const [key, value] of Object.entries(variables)) {
    args.push("--variable", `${key}=${value}`);
  }
  const childEnv = { ...process.env };
  if (env.LINEAR_API_KEY) {
    childEnv.LINEAR_API_KEY = env.LINEAR_API_KEY;
  }
  const result = await runOrThrow("linear", args, { env: childEnv });
  let parsed: { data?: T; errors?: unknown };
  try {
    parsed = JSON.parse(result.stdout) as { data?: T; errors?: unknown };
  } catch {
    throw new Error(`linear api: could not parse response: ${oneLine(result.stdout, 300)}`);
  }
  if (parsed.errors) {
    throw new Error(`linear api error: ${JSON.stringify(parsed.errors)}`);
  }
  if (!parsed.data) {
    throw new Error("linear api returned no data");
  }
  return parsed.data;
};

const toIssue = (raw: RawIssue): Issue => ({
  id: raw.id,
  identifier: raw.identifier,
  title: raw.title ?? "(untitled)",
  description: raw.description ?? "",
  url: raw.url,
  branchName: buildBranchName({
    prefix: choosePrefix({
      labels: (raw.labels?.nodes ?? []).map(n => n.name),
      estimate: raw.estimate,
      description: raw.description
    }),
    identifier: raw.identifier,
    title: raw.title ?? ""
  }),
  stateName: raw.state?.name ?? "",
  updatedAt: raw.updatedAt,
  assigneeName: raw.assignee?.displayName ?? null,
  assigneeIsMe: raw.assignee?.isMe ?? false,
  assigneeMatch: raw.assignee?.email ?? null,
  teamKey: raw.team?.key ?? "",
  teamName: raw.team?.name ?? "",
  projectName: raw.project?.name ?? null,
  parentIdentifier: raw.parent?.identifier ?? undefined
});

const toComment = (raw: RawComment): Comment => ({
  id: raw.id,
  body: raw.body,
  createdAt: raw.createdAt,
  authorName: raw.user?.displayName ?? null,
  isAgent: raw.body.includes(env.AGENT_MARKER)
});

const LIST_QUERY =
  "query GeneIssues($label: String!) { issues(filter: { labels: { name: { eq: $label } } }, first: 200) " +
  "{ nodes { id identifier title description url updatedAt estimate labels { nodes { name } } " +
  "state { name type } team { key name } " +
  "project { name } assignee { id displayName email isMe } parent { identifier } } } }";

const COMMENTS_QUERY =
  "query Comments($id: String!) { issue(id: $id) { comments(first: 100) " +
  "{ nodes { id body createdAt user { id displayName email } } } } }";

const ATTACHMENTS_QUERY =
  "query Attachments($id: String!) { issue(id: $id) { attachments(first: 50) " +
  "{ nodes { title url sourceType } } } }";

// The list query only carries label *names*; removing one needs its id, so refetch
// the issue's labels with ids first, then detach the Gene label by id.
const LABELS_QUERY =
  "query IssueLabels($id: String!) { issue(id: $id) { labels(first: 50) { nodes { id name } } } }";

const REMOVE_LABEL_MUTATION =
  "mutation RemoveLabel($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }";

/** Ensure a comment body carries the agent marker so the daemon recognises it later. */
const withAgentMarker = (body: string): string =>
  body.includes(env.AGENT_MARKER) ? body : `${body}\n\n${env.AGENT_MARKER}`;

// Linear embeds uploaded files as `https://uploads.linear.app/...` links in the
// issue/comment markdown. Note these URLs are extension-less UUID paths — the
// filename (and extension) lives only in the markdown link *label* — so deciding
// what to stage is delegated to collectAttachmentRefsFromText, which reads the label.
const isLinearUpload = (url: string): boolean => url.startsWith("https://uploads.linear.app/");

// Memoised (per process) Linear token for uploads.linear.app downloads:
// undefined = not yet resolved, null = unavailable.
let cachedToken: string | null | undefined;

/** The token uploads.linear.app authenticates with: env first, else the CLI's stored token. */
const resolveToken = async (): Promise<string | null> => {
  if (cachedToken !== undefined) {
    return cachedToken;
  }
  if (env.LINEAR_API_KEY) {
    cachedToken = env.LINEAR_API_KEY;
    return cachedToken;
  }
  // Best-effort: ask the CLI for its token. Tolerate the command not existing.
  const result = await run("linear", ["auth", "token"]);
  const token = result.stdout.trim();
  cachedToken = result.code === 0 && token ? token : null;
  return cachedToken;
};

/** Personal API keys go in the header raw; OAuth access tokens use the Bearer scheme. */
const authHeaders = (token: string): Array<Record<string, string>> => {
  const raw = { Authorization: token };
  const bearer = { Authorization: `Bearer ${token}` };
  return token.startsWith("lin_api_") ? [raw, bearer] : [bearer, raw];
};

export class LinearTracker implements Tracker {
  readonly name = "linear";

  /** All issues carrying the Gene label, regardless of state (caller buckets by state). */
  async listIssues(): Promise<Issue[]> {
    const data = await api<{ issues: { nodes: RawIssue[] } }>(LIST_QUERY, { label: env.LABEL });
    return data.issues.nodes.map(toIssue);
  }

  /** Duplicate of listIssues() with the label taken as a parameter (PROGRAM_LABEL). */
  async listPrograms(label: string): Promise<Issue[]> {
    const data = await api<{ issues: { nodes: RawIssue[] } }>(LIST_QUERY, { label });
    return data.issues.nodes.map(toIssue);
  }

  async getComments(issue: Issue): Promise<Comment[]> {
    const data = await api<{ issue: { comments: { nodes: RawComment[] } } | null }>(COMMENTS_QUERY, {
      id: issue.id
    });
    const nodes = data.issue?.comments.nodes ?? [];
    return nodes.map(toComment).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getAttachments(issue: Issue): Promise<Attachment[]> {
    const data = await api<{
      issue: { attachments: { nodes: { title: string | null; url: string; sourceType: string | null }[] } } | null;
    }>(ATTACHMENTS_QUERY, { id: issue.id });
    const nodes = data.issue?.attachments.nodes ?? [];
    return nodes.map(n => ({ title: n.title ?? null, url: n.url, sourceType: n.sourceType ?? null }));
  }

  /** Stageable uploads.linear.app refs (images + text/docs) from the issue + comment bodies. */
  async collectAttachmentUrls(issue: Issue, comments: Comment[]): Promise<AttachmentRef[]> {
    const haystack = [issue.description, ...comments.map(c => c.body)].join("\n");
    return collectAttachmentRefsFromText(haystack, isLinearUpload);
  }

  /** Download an image, trying both auth schemes; null on no-token / 401 / network error. */
  async fetchAttachment(url: string): Promise<Buffer | null> {
    const token = await resolveToken();
    if (!token) {
      return null;
    }
    for (const headers of authHeaders(token)) {
      try {
        // Retry transient drops/timeouts/5xx; a 401/403 comes back as-is so we can
        // fall through to the next auth scheme below.
        const res = await fetchRetryTimeout(url, { headers });
        if (res.ok) {
          return Buffer.from(await res.arrayBuffer());
        }
        if (res.status !== 401 && res.status !== 403) {
          logger.warn(`[linear] attachment ${url} → HTTP ${res.status}`);
          return null;
        }
      } catch (error) {
        logger.warn(`[linear] attachment ${url} fetch failed:`, error instanceof Error ? error.message : error);
        return null;
      }
    }
    logger.warn(`[linear] attachment ${url} → unauthorized (token rejected)`);
    return null;
  }

  /** Post a comment as Gene (marker appended). No-op (logged) under dry-run. */
  async postComment(issue: Issue, body: string): Promise<void> {
    const marked = withAgentMarker(body);
    if (env.DRY_RUN) {
      logger.info(`[linear] (dry-run) would comment on ${issue.identifier}: ${oneLine(marked)}`);
      return;
    }
    const dir = await mkdtemp(path.join(tmpdir(), "gene-comment-"));
    const file = path.join(dir, "body.md");
    try {
      await writeFile(file, marked, "utf-8");
      await runOrThrow("linear", [
        "issue",
        "comment",
        "add",
        issue.identifier,
        "--body-file",
        file,
        ...workspaceArgs()
      ]);
      logger.info(`[linear] commented on ${issue.identifier}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Move an issue to a workflow state (by name). No-op (logged) under dry-run. */
  async moveToState(issue: Issue, stateName: string): Promise<void> {
    if (env.DRY_RUN) {
      logger.info(`[linear] (dry-run) would move ${issue.identifier} → "${stateName}"`);
      return;
    }
    await runOrThrow("linear", [
      "issue",
      "update",
      issue.identifier,
      "--state",
      stateName,
      ...workspaceArgs()
    ]);
    logger.info(`[linear] moved ${issue.identifier} → "${stateName}"`);
  }

  /**
   * Drop the Gene label from an issue (so the daemon stops picking it up). Best-effort:
   * some workspaces/CLIs may reject the label mutation, so a failure is warned and
   * folded into a `false` return (never thrown) — the caller keeps the row on the board.
   * Resolves `true` when the label is gone (removed now, or already absent). No-op that
   * resolves `true` under dry-run.
   */
  async removeGeneLabel(issue: Issue): Promise<boolean> {
    if (env.DRY_RUN) {
      logger.info(`[linear] (dry-run) would remove "${env.LABEL}" label from ${issue.identifier}`);
      return true;
    }
    try {
      const data = await api<{ issue: { labels: { nodes: { id: string; name: string }[] } } | null }>(LABELS_QUERY, {
        id: issue.id
      });
      const label = (data.issue?.labels.nodes ?? []).find(l => l.name.toLowerCase() === env.LABEL.toLowerCase());
      if (!label) {
        logger.info(`[linear] ${issue.identifier} has no "${env.LABEL}" label — nothing to remove`);
        return true;
      }
      // The mutation reports its own outcome — a `success: false` (e.g. permissions) comes
      // back without a GraphQL error, so check it rather than assume the write landed.
      const result = await api<{ issueRemoveLabel: { success: boolean } }>(REMOVE_LABEL_MUTATION, {
        id: issue.id,
        labelId: label.id
      });
      if (!result.issueRemoveLabel.success) {
        logger.warn(`[linear] issueRemoveLabel reported failure for ${issue.identifier} (leaving "${env.LABEL}")`);
        return false;
      }
      logger.info(`[linear] removed "${env.LABEL}" label from ${issue.identifier}`);
      return true;
    } catch (error) {
      logger.warn(
        `[linear] could not remove "${env.LABEL}" label from ${issue.identifier} (leaving it):`,
        error instanceof Error ? error.message : error
      );
      return false;
    }
  }

  /**
   * Whether an issue is assigned to the user Gene works for (env.ASSIGNEE):
   *   - "me"  → the authenticated Linear user (issue.assigneeIsMe);
   *   - "any" → no filter (every assignee, including unassigned);
   *   - else  → an exact assignee-email match (case-insensitive).
   */
  isAssignedToOwner(issue: Issue): boolean {
    const who = env.ASSIGNEE.toLowerCase();
    if (who === "any") {
      return true;
    }
    if (who === "me") {
      return issue.assigneeIsMe;
    }
    return issue.assigneeMatch?.toLowerCase() === who;
  }

  /** Human-readable label for env.ASSIGNEE, for logging ("you" / "anyone" / the email). */
  ownerLabel(): string {
    const who = env.ASSIGNEE.toLowerCase();
    if (who === "me") {
      return "you";
    }
    if (who === "any") {
      return "anyone";
    }
    return env.ASSIGNEE;
  }

  /** Prompt block: how the agent comments / moves state via the `linear` CLI. */
  writeBackSnippet(issue: Issue): string {
    const ws = workspaceFlag();
    return [
      "# How to write back to Linear (use the `linear` CLI)",
      "",
      "- **Comment:** write the body to a temp file and run",
      `  \`linear issue comment add ${issue.identifier} --body-file <file>${ws}\``,
      "  (or `--body \"<text>\"` for a one-liner). Keep each comment to one focused message.",
      `- **Move state:** \`linear issue update ${issue.identifier} --state "<State>"${ws}\`.`,
      `  Terminal states for you are **"${env.BLOCKED_STATE}"** and **"${env.REVIEW_STATE}"** (see outcomes).`
    ].join("\n");
  }

  /**
   * Prompt block: how the agent creates a subcard (Shape B) as a true Linear sub-issue.
   * `--parent` makes the native parent/child link the daemon reads back via `parent { identifier }`;
   * `--label`/`--assignee self`/`--state` put the new issue into the normal pipeline.
   */
  subcardSnippet(issue: Issue): string {
    const ws = workspaceFlag();
    const team = issue.teamKey ? ` --team ${issue.teamKey}` : "";
    return [
      "# How to split into subcards (Shape B)",
      "",
      "Create each subcard as a native Linear **sub-issue** of this issue. For each subtask:",
      "```",
      `linear issue create --parent ${issue.identifier}${team} --label "${env.LABEL}" --assignee self \\`,
      `  --state "${env.TRIGGER_STATE}" --title "<subtask title>" --description-file <file>${ws}`,
      "```",
      `The \`--parent ${issue.identifier}\` link is REQUIRED — the daemon reads it to auto-complete this`,
      `parent once every sub-issue is done. \`--label "${env.LABEL}"\` is what makes the daemon pick the`,
      "sub-issue up; keep it. Write the description (Problem / Acceptance criteria) to the temp file.",
      "",
      "After creating all sub-issues, post a summary comment on THIS issue listing them, then move THIS",
      `issue to "${env.BLOCKED_STATE}" and exit. Do NOT open a change request for this parent.`
    ].join("\n");
  }

  allowedTools(): string[] {
    return ["Bash(linear *)"];
  }
}
