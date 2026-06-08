/**
 * Per-issue repository targeting.
 *
 * An issue declares its target repo simply by including a GitLab or GitHub link
 * in its description (or, failing that, a comment) — the FIRST such link wins.
 * The forge is inferred from the host, and a monorepo subdirectory is read from
 * a `…/tree/<branch>/<path>` URL when present. Issues with no link fall back to a
 * configured per-team default (e.g. CLOUD → nest.datacrunch.io), so existing
 * single-repo issues keep working untouched.
 *
 * Examples that resolve correctly:
 *   https://gitlab.com/example/example-repo                           → gitlab, whole repo
 *   https://gitlab.com/example/example-repo/-/tree/main/path/to/dir   → gitlab, subdir path/to/dir
 *   https://github.com/example/example-repo                           → github, whole repo
 */

import path from "node:path";
import { env, REPOS_ROOT } from "./config.ts";
import type { Comment, Issue } from "./tracker/index.ts";

export type ForgeName = "gitlab" | "github";

export type RepoTarget = {
  /** Which forge hosts this repo — drives the CLI (glab/gh) and prompt snippet. */
  forge: ForgeName;
  /** Forge host, e.g. "gitlab.datacrunch.io" / "github.com". */
  host: string;
  /** Project / "owner/repo" path, e.g. "datacrunch/nest.datacrunch.io". */
  repoPath: string;
  /** Monorepo subdirectory to scope work to (from a /tree/ URL), if any. */
  subdir?: string;
  /** Base branch parsed from a /tree/<ref>/ URL, if the link pinned one. */
  ref?: string;
};

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

const isGithubHost = (host: string): boolean => GITHUB_HOSTS.has(host);

const isGitlabHost = (host: string): boolean =>
  host === env.GITLAB_HOST || host.includes("gitlab");

/** Join a path tail into a subdir; for blob (file) links, drop the filename. */
const subdirFrom = (kind: string, parts: string[]): string | undefined => {
  const dirParts = kind === "blob" ? parts.slice(0, -1) : parts;
  const joined = dirParts.filter(Boolean).join("/");
  return joined || undefined;
};

const stripGit = (s: string): string => s.replace(/\.git$/, "");

/**
 * Parse a single URL into a RepoTarget, or null if it isn't a GitLab/GitHub repo
 * link we recognise. Handles bare project URLs, `…/tree|blob/<ref>/<path>` deep
 * links, and GitLab nested groups (group/subgroup/project).
 */
export const parseRepoUrl = (raw: string): RepoTarget | null => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  const host = url.hostname;
  const github = isGithubHost(host);
  const gitlab = !github && isGitlabHost(host);
  if (!github && !gitlab) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  if (github) {
    const repoPath = `${segments[0]}/${stripGit(segments[1]!)}`;
    let subdir: string | undefined;
    let ref: string | undefined;
    const kind = segments[2];
    if ((kind === "tree" || kind === "blob") && segments.length >= 4) {
      ref = segments[3];
      subdir = subdirFrom(kind, segments.slice(4));
    }
    return { forge: "github", host, repoPath, subdir, ref };
  }

  // GitLab: the "/-/" segment separates the project path from sub-routes; nested
  // groups mean the project path can be 2+ segments deep.
  const dash = segments.indexOf("-");
  let repoPath: string;
  let subdir: string | undefined;
  let ref: string | undefined;
  if (dash === -1) {
    repoPath = stripGit(segments.join("/"));
  } else {
    repoPath = stripGit(segments.slice(0, dash).join("/"));
    const rest = segments.slice(dash + 1); // e.g. ["tree","main","apps","console"]
    const kind = rest[0];
    if ((kind === "tree" || kind === "blob") && rest.length >= 2) {
      ref = rest[1];
      subdir = subdirFrom(kind, rest.slice(2));
    }
  }
  if (!repoPath.includes("/")) {
    return null; // a group URL, not a project
  }
  return { forge: "gitlab", host, repoPath, subdir, ref };
};

// Capture http(s) URLs; the character class stops at whitespace and the
// delimiters that wrap links in markdown/prose ( ) [ ] < > " ' ` .
const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/g;

/** First GitLab/GitHub repo link found in a block of text, or null. */
export const findTargetInText = (text: string): RepoTarget | null => {
  if (!text) {
    return null;
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    const cleaned = match[0].replace(/[.,;:]+$/, ""); // trailing prose punctuation
    const target = parseRepoUrl(cleaned);
    if (target) {
      return target;
    }
  }
  return null;
};

/** A reference to a specific change request (MR/PR) on a forge. */
export type ChangeRequestRef = {
  forge: ForgeName;
  host: string;
  repoPath: string;
  /** MR iid / PR number. */
  iid: string;
};

const firstInt = (segment: string | undefined): string | null => {
  const m = (segment ?? "").match(/^\d+/);
  return m ? m[0] : null;
};

/**
 * Parse an MR/PR *deep* link into a ChangeRequestRef, or null. Unlike
 * `parseRepoUrl` (which stops at the repo), this recognises the change-request
 * sub-route:
 *   GitLab:  https://<host>/<repoPath…>/-/merge_requests/<iid>
 *   GitHub:  https://<host>/<owner>/<repo>/pull/<number>
 */
export const parseChangeRequestUrl = (raw: string): ChangeRequestRef | null => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  const host = url.hostname;
  const github = isGithubHost(host);
  const gitlab = !github && isGitlabHost(host);
  if (!github && !gitlab) {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);

  if (github) {
    const pull = segments.indexOf("pull");
    const iid = pull >= 2 ? firstInt(segments[pull + 1]) : null;
    if (!iid) {
      return null;
    }
    return { forge: "github", host, repoPath: `${segments[0]}/${stripGit(segments[1]!)}`, iid };
  }

  // GitLab: the project path precedes "/-/merge_requests/<iid>".
  const dash = segments.indexOf("-");
  if (dash < 1) {
    return null;
  }
  const rest = segments.slice(dash + 1); // ["merge_requests","<iid>", …]
  const iid = rest[0] === "merge_requests" ? firstInt(rest[1]) : null;
  if (!iid) {
    return null;
  }
  const repoPath = stripGit(segments.slice(0, dash).join("/"));
  if (!repoPath.includes("/")) {
    return null;
  }
  return { forge: "gitlab", host, repoPath, iid };
};

/** Every distinct MR/PR ref found in a block of text. */
export const findChangeRequestRefs = (text: string): ChangeRequestRef[] => {
  if (!text) {
    return [];
  }
  const refs: ChangeRequestRef[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const cleaned = match[0].replace(/[.,;:]+$/, "");
    const ref = parseChangeRequestUrl(cleaned);
    if (ref) {
      refs.push(ref);
    }
  }
  return refs;
};

/** True when a change-request ref points at the same repo as a resolved target. */
export const refMatchesTarget = (ref: ChangeRequestRef, target: RepoTarget): boolean =>
  ref.forge === target.forge && ref.host === target.host && ref.repoPath === target.repoPath;

/** Per-team default repo URLs, used when an issue carries no link. */
const DEFAULT_TARGET_URLS: Record<string, string> = {
  CLOUD: `https://${env.GITLAB_HOST}/datacrunch/nest.datacrunch.io`
};

/** Merge in any `GENE_REPO_MAP` override — a JSON object of team → repo URL. */
const buildDefaults = (): Record<string, string> => {
  const map: Record<string, string> = { ...DEFAULT_TARGET_URLS };
  if (!env.REPO_MAP) {
    return map;
  }
  let override: unknown;
  try {
    override = JSON.parse(env.REPO_MAP);
  } catch (error) {
    throw new Error(
      `GENE_REPO_MAP is not valid JSON: ${error instanceof Error ? error.message : error}`
    );
  }
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    throw new Error("GENE_REPO_MAP must be a JSON object keyed by team key, e.g. {\"CLOUD\":\"https://…\"}");
  }
  for (const [team, value] of Object.entries(override as Record<string, unknown>)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`GENE_REPO_MAP.${team} must be a repo URL string`);
    }
    map[team] = value.trim();
  }
  return map;
};

const DEFAULT_TARGETS = buildDefaults();

/** The configured default RepoTarget for a team, or null if none is mapped. */
export const defaultTargetFor = (teamKey: string): RepoTarget | null => {
  const url = DEFAULT_TARGETS[teamKey];
  if (!url) {
    return null;
  }
  const target = parseRepoUrl(url);
  if (!target) {
    throw new Error(`Default repo URL for team "${teamKey}" is not a valid GitLab/GitHub URL: ${url}`);
  }
  return target;
};

/** Every configured default target — used by `npm run clone` to warm the cache. */
export const defaultTargets = (): RepoTarget[] =>
  Object.keys(DEFAULT_TARGETS)
    .map(team => defaultTargetFor(team))
    .filter((t): t is RepoTarget => t !== null);

/**
 * Resolve the repo an issue targets: the first GitLab/GitHub link in the
 * description, else the first such link in a comment, else the team default.
 * Returns null only when there's no link AND no default for the team.
 */
export const resolveTarget = (issue: Issue, comments: Comment[] = []): RepoTarget | null => {
  const fromDescription = findTargetInText(issue.description);
  if (fromDescription) {
    return fromDescription;
  }
  for (const comment of comments) {
    const fromComment = findTargetInText(comment.body);
    if (fromComment) {
      return fromComment;
    }
  }
  return defaultTargetFor(issue.teamKey);
};

/** A short "host/repoPath[ /subdir]" label for logs and the prompt. */
export const targetLabel = (target: RepoTarget): string =>
  target.subdir
    ? `${target.host}/${target.repoPath} (${target.subdir})`
    : `${target.host}/${target.repoPath}`;

/** Absolute path to the local clone for a target (repoPath nests under repos/). */
export const localPathFor = (target: RepoTarget): string => path.join(REPOS_ROOT, target.repoPath);
