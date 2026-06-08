/**
 * Linear access layer. Reads go through `linear api` (raw GraphQL, for filtering
 * by label + selecting exactly the fields we need); writes go through the
 * high-level `linear issue …` commands.
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
import logger from "./logger.ts";
import { env } from "./config.ts";
import { runOrThrow } from "./exec.ts";

export type LinearIssue = {
  id: string; // UUID (used for GraphQL sub-queries)
  identifier: string; // e.g. CLOUD-1094 (used for the `linear` CLI + branch names)
  title: string;
  description: string;
  url: string;
  branchName: string;
  updatedAt: string;
  stateName: string;
  stateType: string;
  teamKey: string;
  teamName: string;
  projectName: string | null;
};

export type LinearComment = {
  id: string;
  body: string;
  createdAt: string;
  authorId: string | null;
  authorName: string | null;
  authorEmail: string | null;
  /** True when the comment was written by Gene (carries the agent marker). */
  isAgent: boolean;
};

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
};

type RawComment = {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; displayName: string | null; email: string | null } | null;
};

const workspaceArgs = (): string[] => (env.LINEAR_WORKSPACE ? ["-w", env.LINEAR_WORKSPACE] : []);

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

const toIssue = (raw: RawIssue): LinearIssue => ({
  id: raw.id,
  identifier: raw.identifier,
  title: raw.title ?? "(untitled)",
  description: raw.description ?? "",
  url: raw.url,
  branchName: raw.branchName,
  updatedAt: raw.updatedAt,
  stateName: raw.state?.name ?? "",
  stateType: raw.state?.type ?? "",
  teamKey: raw.team?.key ?? "",
  teamName: raw.team?.name ?? "",
  projectName: raw.project?.name ?? null
});

const toComment = (raw: RawComment): LinearComment => ({
  id: raw.id,
  body: raw.body,
  createdAt: raw.createdAt,
  authorId: raw.user?.id ?? null,
  authorName: raw.user?.displayName ?? null,
  authorEmail: raw.user?.email ?? null,
  isAgent: raw.body.includes(env.AGENT_MARKER)
});

const LIST_QUERY =
  "query GeneIssues($label: String!) { issues(filter: { labels: { name: { eq: $label } } }, first: 200) " +
  "{ nodes { id identifier title description url branchName updatedAt state { name type } team { key name } project { name } } } }";

/** All issues carrying the Gene label, regardless of state (caller buckets by state). */
export const listGeneIssues = async (): Promise<LinearIssue[]> => {
  const data = await api<{ issues: { nodes: RawIssue[] } }>(LIST_QUERY, { label: env.GENE_LABEL });
  return data.issues.nodes.map(toIssue);
};

const COMMENTS_QUERY =
  "query Comments($id: String!) { issue(id: $id) { comments(first: 100) " +
  "{ nodes { id body createdAt user { id displayName email } } } } }";

/** Chronologically-sorted comments for an issue (by UUID). */
export const getComments = async (issueUuid: string): Promise<LinearComment[]> => {
  const data = await api<{ issue: { comments: { nodes: RawComment[] } } | null }>(COMMENTS_QUERY, {
    id: issueUuid
  });
  const nodes = data.issue?.comments.nodes ?? [];
  return nodes.map(toComment).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

/** Ensure a comment body carries the agent marker so the daemon recognises it later. */
export const withAgentMarker = (body: string): string =>
  body.includes(env.AGENT_MARKER) ? body : `${body}\n\n${env.AGENT_MARKER}`;

/** Post a comment as Gene (marker appended). No-op (logged) under dry-run. */
export const postComment = async (identifier: string, body: string): Promise<void> => {
  const withMarker = withAgentMarker(body);
  if (env.DRY_RUN) {
    logger.info(`[linear] (dry-run) would comment on ${identifier}: ${oneLine(withMarker)}`);
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "gene-comment-"));
  const file = path.join(dir, "body.md");
  try {
    await writeFile(file, withMarker, "utf-8");
    await runOrThrow("linear", [
      "issue",
      "comment",
      "add",
      identifier,
      "--body-file",
      file,
      ...workspaceArgs()
    ]);
    logger.info(`[linear] commented on ${identifier}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Move an issue to a workflow state (by name). No-op (logged) under dry-run. */
export const moveState = async (identifier: string, stateName: string): Promise<void> => {
  if (env.DRY_RUN) {
    logger.info(`[linear] (dry-run) would move ${identifier} → "${stateName}"`);
    return;
  }
  await runOrThrow("linear", ["issue", "update", identifier, "--state", stateName, ...workspaceArgs()]);
  logger.info(`[linear] moved ${identifier} → "${stateName}"`);
};
