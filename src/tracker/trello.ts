/**
 * Trello tracker. Reads and writes go through the `trello` CLI
 * (https://github.com/Scale-Flow/trello-cli) — a Go single binary on PATH that
 * emits a `{ "ok": true, "data": … }` / `{ "ok": false, "error": {…} }` envelope
 * and authenticates from the environment (TRELLO_API_KEY / TRELLO_TOKEN), so the
 * daemon and the spawned agent both inherit the creds. The one thing the CLI
 * can't do — download an attachment binary — uses the REST endpoint with an
 * OAuth Authorization header (ported from pipeline/trello.ts).
 *
 * Semantics mirror Linear: the Gene *label* marks ownership, a *list* is the
 * lifecycle state (the card's list name = stateName), and "assigned to me" filters
 * by card membership. Wrapped as `TrelloTracker` behind the neutral Tracker
 * interface (see ./index.ts). All writes honour GENE_DRY_RUN.
 */

import logger from "../logger.ts";
import { env } from "../config.ts";
import { run } from "../exec.ts";
import { fetchRetryTimeout } from "../fetch.ts";
import type { Attachment, Comment, Issue, Tracker } from "./index.ts";

type RawCard = {
  id: string;
  name?: string | null;
  desc?: string | null;
  shortLink?: string | null;
  shortUrl?: string | null;
  url?: string | null;
  idList?: string | null;
  idLabels?: string[] | null;
  idMembers?: string[] | null;
  dateLastActivity?: string | null;
};

type RawList = { id: string; name?: string | null };
type RawLabel = { id: string; name?: string | null };
type RawMember = { id: string; username?: string | null; fullName?: string | null };

type RawTrelloComment = {
  id: string;
  date?: string | null;
  createdAt?: string | null;
  text?: string | null;
  data?: { text?: string | null } | null;
  memberCreator?: { id?: string; username?: string | null; fullName?: string | null } | null;
};

type RawAttachment = {
  id: string;
  name?: string | null;
  url?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
};

// Capture http(s) URLs; the character class stops at whitespace and the
// delimiters that wrap links in markdown/prose.
const URL_PATTERN = /https?:\/\/[^\s)\]"'`<>]+/g;
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg)(\?|#|$)/i;

const oneLine = (value: string, max = 140): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Ensure a comment body carries the agent marker so the daemon recognises it later. */
const withAgentMarker = (body: string): string =>
  body.includes(env.AGENT_MARKER) ? body : `${body}\n\n${env.AGENT_MARKER}`;

const boardId = (): string => {
  if (!env.TRELLO_BOARD) {
    throw new Error("TRELLO_BOARD is required for the Trello tracker");
  }
  return env.TRELLO_BOARD;
};

/** Pass the creds explicitly so the CLI authenticates regardless of how env was loaded. */
const trelloEnv = (): NodeJS.ProcessEnv => {
  const childEnv = { ...process.env };
  if (env.TRELLO_API_KEY) {
    childEnv.TRELLO_API_KEY = env.TRELLO_API_KEY;
  }
  if (env.TRELLO_TOKEN) {
    childEnv.TRELLO_TOKEN = env.TRELLO_TOKEN;
  }
  return childEnv;
};

/** Run a `trello` CLI command and unwrap its `{ok,data}` envelope (throws on `ok:false`). */
const trelloCli = async <T>(args: string[]): Promise<T> => {
  const result = await run("trello", args, { env: trelloEnv() });
  let parsed: { ok?: boolean; data?: T; error?: { code?: string; message?: string } } | undefined;
  if (result.stdout.trim()) {
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      /* fall through to the error below */
    }
  }
  if (!parsed) {
    throw new Error(
      `trello ${args.join(" ")} failed (exit ${result.code}): ${oneLine(result.stderr || result.stdout, 300)}`
    );
  }
  if (!parsed.ok) {
    const e = parsed.error;
    throw new Error(`trello ${args.join(" ")} failed: ${e?.code ?? "ERROR"} — ${e?.message ?? "unknown error"}`);
  }
  return parsed.data as T;
};

// Board metadata, resolved once per process (the tracker is a singleton): list
// names↔ids, the Gene label id, board members, and the authenticated member.
let boardName: string | undefined;
let listsCache: RawList[] | undefined;
let labelsCache: RawLabel[] | undefined;
let membersCache: RawMember[] | undefined;
let meCache: RawMember | null | undefined;
let listMapCache: Record<string, string> | null | undefined;

/** Parse + cache the optional TRELLO_LIST_MAP (state-name → list-id) override. */
const parseListMap = (): Record<string, string> => {
  if (listMapCache !== undefined) {
    return listMapCache ?? {};
  }
  if (!env.TRELLO_LIST_MAP) {
    listMapCache = null;
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.TRELLO_LIST_MAP);
  } catch (error) {
    throw new Error(`TRELLO_LIST_MAP is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('TRELLO_LIST_MAP must be a JSON object of state-name → list-id, e.g. {"Todo":"<listId>"}');
  }
  const map: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`TRELLO_LIST_MAP.${name} must be a list-id string`);
    }
    map[name] = value.trim();
  }
  listMapCache = map;
  return map;
};

const ensureMeta = async (): Promise<void> => {
  if (listsCache && labelsCache && membersCache && meCache !== undefined) {
    return;
  }
  const board = boardId();
  const [lists, labels, members, auth, boardInfo] = await Promise.all([
    trelloCli<RawList[]>(["lists", "list", "--board", board]),
    trelloCli<RawLabel[]>(["labels", "list", "--board", board]),
    trelloCli<RawMember[]>(["members", "list", "--board", board]),
    trelloCli<{ member?: RawMember | null }>(["auth", "status"]),
    trelloCli<{ name?: string | null }>(["boards", "get", "--board", board]).catch(() => ({ name: undefined }))
  ]);
  listsCache = lists ?? [];
  labelsCache = labels ?? [];
  membersCache = members ?? [];
  meCache = auth?.member ?? null;
  boardName = boardInfo?.name ?? undefined;
};

/** The board's Gene label id (matched by name, case-insensitive), or null if absent. */
const labelId = (): string | null => {
  const want = env.LABEL.toLowerCase();
  return (labelsCache ?? []).find(l => (l.name ?? "").toLowerCase() === want)?.id ?? null;
};

/** A card's list id → the list's name (the lifecycle state). */
const listName = (idList: string | null | undefined): string => {
  if (!idList) {
    return "";
  }
  return (listsCache ?? []).find(l => l.id === idList)?.name ?? "";
};

/** Resolve a state name to a list id — TRELLO_LIST_MAP override first, else by list name. */
const listIdForState = (stateName: string): string | null => {
  const override = parseListMap()[stateName];
  if (override) {
    return override;
  }
  const want = stateName.toLowerCase();
  return (listsCache ?? []).find(l => (l.name ?? "").toLowerCase() === want)?.id ?? null;
};

/** Map a card's member ids to usernames (board members + the authenticated user). */
const usernamesFor = (idMembers: string[]): string[] => {
  const all = [...(membersCache ?? [])];
  const me = meCache;
  if (me && !all.some(m => m.id === me.id)) {
    all.push(me);
  }
  return idMembers
    .map(id => all.find(m => m.id === id)?.username ?? null)
    .filter((u): u is string => Boolean(u));
};

const toCard = (raw: RawCard): Issue => {
  const me = meCache;
  const idMembers = raw.idMembers ?? [];
  const usernames = usernamesFor(idMembers);
  const shortLink = raw.shortLink ?? raw.id;
  return {
    id: raw.id,
    identifier: shortLink,
    title: raw.name ?? "(untitled)",
    description: raw.desc ?? "",
    url: raw.shortUrl ?? raw.url ?? "",
    branchName: `gene/${shortLink}`,
    stateName: listName(raw.idList),
    updatedAt: raw.dateLastActivity ?? "",
    assigneeName: usernames.length > 0 ? usernames.join(", ") : null,
    assigneeIsMe: me ? idMembers.includes(me.id) : false,
    assigneeMatch: usernames.length > 0 ? usernames.join(",") : null,
    teamKey: "",
    teamName: boardName ?? "",
    projectName: null
  };
};

const toComment = (raw: RawTrelloComment): Comment => {
  const body = raw.text ?? raw.data?.text ?? "";
  return {
    id: raw.id,
    body,
    createdAt: raw.date ?? raw.createdAt ?? "",
    authorName: raw.memberCreator?.fullName ?? raw.memberCreator?.username ?? null,
    isAgent: body.includes(env.AGENT_MARKER)
  };
};

export class TrelloTracker implements Tracker {
  readonly name = "trello";

  /** All Gene-labelled cards on the board, any list (caller buckets by state = list name). */
  async listIssues(): Promise<Issue[]> {
    await ensureMeta();
    const wantLabel = labelId();
    if (!wantLabel) {
      logger.warn(`[trello] no label named "${env.LABEL}" on board ${boardId()} — no issues will match`);
      return [];
    }
    const cards = await trelloCli<RawCard[]>(["cards", "list", "--board", boardId()]);
    return (cards ?? []).filter(c => (c.idLabels ?? []).includes(wantLabel)).map(toCard);
  }

  async getComments(issue: Issue): Promise<Comment[]> {
    const raw = await trelloCli<RawTrelloComment[]>(["comments", "list", "--card", issue.id]);
    return (raw ?? []).map(toComment).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getAttachments(issue: Issue): Promise<Attachment[]> {
    const raw = await trelloCli<RawAttachment[]>(["attachments", "list", "--card", issue.id]);
    return (raw ?? [])
      .filter(a => Boolean(a.url))
      .map(a => ({ title: a.name ?? null, url: a.url as string, sourceType: a.mimeType ?? null }));
  }

  /** Image URLs to stage: the card's image attachments + any inline image links in the text. */
  async collectImageUrls(issue: Issue, comments: Comment[]): Promise<string[]> {
    const seen = new Set<string>();
    try {
      const atts = await trelloCli<RawAttachment[]>(["attachments", "list", "--card", issue.id]);
      for (const a of atts ?? []) {
        if (!a.url) {
          continue;
        }
        const isImage =
          (a.mimeType ?? "").startsWith("image/") || IMAGE_EXT_PATTERN.test(a.fileName ?? a.name ?? a.url);
        if (isImage) {
          seen.add(a.url);
        }
      }
    } catch (error) {
      logger.warn(
        `[trello] [${issue.identifier}] could not list attachments:`,
        error instanceof Error ? error.message : error
      );
    }
    const haystack = [issue.description, ...comments.map(c => c.body)].join("\n");
    for (const match of haystack.matchAll(URL_PATTERN)) {
      if (IMAGE_EXT_PATTERN.test(match[0])) {
        seen.add(match[0]);
      }
    }
    return [...seen];
  }

  /** Download via REST with an OAuth header (CLI has no download); null on failure. */
  async fetchAttachment(url: string): Promise<Buffer | null> {
    if (!env.TRELLO_API_KEY || !env.TRELLO_TOKEN) {
      return null;
    }
    const headers = {
      Authorization: `OAuth oauth_consumer_key="${env.TRELLO_API_KEY}", oauth_token="${env.TRELLO_TOKEN}"`
    };
    try {
      const res = await fetchRetryTimeout(url, { headers });
      if (res.ok) {
        return Buffer.from(await res.arrayBuffer());
      }
      logger.warn(`[trello] attachment ${url} → HTTP ${res.status}`);
      return null;
    } catch (error) {
      logger.warn(`[trello] attachment ${url} fetch failed:`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  /** Post a comment as Gene (marker appended). No-op (logged) under dry-run. */
  async postComment(issue: Issue, body: string): Promise<void> {
    const marked = withAgentMarker(body);
    if (env.DRY_RUN) {
      logger.info(`[trello] (dry-run) would comment on ${issue.identifier}: ${oneLine(marked)}`);
      return;
    }
    await trelloCli(["comments", "add", "--card", issue.id, "--text", marked]);
    logger.info(`[trello] commented on ${issue.identifier}`);
  }

  /** Move a card to the list whose name is `stateName`. No-op (logged) under dry-run. */
  async moveToState(issue: Issue, stateName: string): Promise<void> {
    if (env.DRY_RUN) {
      logger.info(`[trello] (dry-run) would move ${issue.identifier} → "${stateName}"`);
      return;
    }
    await ensureMeta();
    const listId = listIdForState(stateName);
    if (!listId) {
      throw new Error(
        `Trello: no list named "${stateName}" on board ${boardId()} — rename the list or set TRELLO_LIST_MAP. ` +
          `Cannot move ${issue.identifier}.`
      );
    }
    await trelloCli(["cards", "move", "--card", issue.id, "--list", listId]);
    logger.info(`[trello] moved ${issue.identifier} → "${stateName}"`);
  }

  /**
   * Whether a card is assigned to the user Gene works for (env.ASSIGNEE):
   *   - "me"  → the authenticated Trello user is a member of the card;
   *   - "any" → no filter;
   *   - else  → the value matches one of the card's member usernames (case-insensitive).
   */
  isAssignedToOwner(issue: Issue): boolean {
    const who = env.ASSIGNEE.toLowerCase();
    if (who === "any") {
      return true;
    }
    if (who === "me") {
      return issue.assigneeIsMe;
    }
    return (issue.assigneeMatch ?? "")
      .toLowerCase()
      .split(",")
      .includes(who);
  }

  /** Human-readable label for env.ASSIGNEE, for logging ("you" / "anyone" / the username). */
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

  /** Prompt block: how the agent comments / moves the card via the `trello` CLI. */
  writeBackSnippet(issue: Issue): string {
    const board = env.TRELLO_BOARD ?? "<board>";
    return [
      "# How to write back to Trello (use the `trello` CLI)",
      "",
      `- **Comment:** \`trello comments add --card ${issue.id} --text "<body>"\` (end every comment with`,
      "  the marker line — see Hard rules). When you open the change request, include its URL in a comment",
      "  so it stays linked to this card. Keep each comment to one focused message.",
      "- **Move state (Trello lists):** look up the destination list id with",
      `  \`trello lists list --board ${board}\`, then \`trello cards move --card ${issue.id} --list <listId>\`.`,
      `  Terminal states for you are the lists named **"${env.BLOCKED_STATE}"** and **"${env.REVIEW_STATE}"** (see outcomes).`
    ].join("\n");
  }

  allowedTools(): string[] {
    return ["Bash(trello *)"];
  }
}
