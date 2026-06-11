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
import { buildBranchName, prefixFromLinearBranch } from "../branch.ts";
import { run, runOrThrow } from "../exec.ts";
import { fetchRetryTimeout } from "../fetch.ts";
import type { Attachment, Comment, Issue, Tracker } from "./index.ts";

type RawIssue = {
  id: string;
  identifier: string;
  title: string | null;
  description: string | null;
  url: string;
  branchName: string;
  updatedAt: string;
  state: { name: string; type: string } | null;
  team: { key: string; name: string } | null;
  project: { name: string } | null;
  assignee: { id: string; displayName: string | null; email: string | null; isMe: boolean } | null;
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
    prefix: prefixFromLinearBranch(raw.branchName),
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
  projectName: raw.project?.name ?? null
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
  "{ nodes { id identifier title description url branchName updatedAt state { name type } team { key name } " +
  "project { name } assignee { id displayName email isMe } } } }";

const COMMENTS_QUERY =
  "query Comments($id: String!) { issue(id: $id) { comments(first: 100) " +
  "{ nodes { id body createdAt user { id displayName email } } } } }";

const ATTACHMENTS_QUERY =
  "query Attachments($id: String!) { issue(id: $id) { attachments(first: 50) " +
  "{ nodes { title url sourceType } } } }";

/** Ensure a comment body carries the agent marker so the daemon recognises it later. */
const withAgentMarker = (body: string): string =>
  body.includes(env.AGENT_MARKER) ? body : `${body}\n\n${env.AGENT_MARKER}`;

// Linear embeds uploaded files as `https://uploads.linear.app/...` URLs in the
// issue/comment markdown; we scrape the image ones and download them with the token.
const UPLOAD_URL_PATTERN = /https:\/\/uploads\.linear\.app\/[^\s)\]"'<>]+/g;
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg)(\?|#|$)/i;

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

  /** Distinct uploads.linear.app image URLs from the issue + comment bodies. */
  async collectImageUrls(issue: Issue, comments: Comment[]): Promise<string[]> {
    const haystack = [issue.description, ...comments.map(c => c.body)].join("\n");
    const seen = new Set<string>();
    for (const match of haystack.matchAll(UPLOAD_URL_PATTERN)) {
      const url = match[0];
      if (IMAGE_EXT_PATTERN.test(url)) {
        seen.add(url);
      }
    }
    return [...seen];
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

  allowedTools(): string[] {
    return ["Bash(linear *)"];
  }
}
