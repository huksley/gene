/**
 * Trello tracker. Reads and writes go through the bundled, dependency-free Trello
 * REST wrapper (../../trello): `createTrelloClient()` authenticates with
 * TRELLO_API_KEY + TRELLO_TOKEN — Trello requires BOTH on every call. The one
 * thing the wrapper doesn't cover, attachments, is done here with direct REST:
 * listing via key+token query auth, downloading via an OAuth Authorization header.
 *
 * The spawned agent can't import the wrapper (it runs inside a different repo's
 * worktree), so it writes back by invoking the bundled CLI directly:
 * `node <REPO_ROOT>/trello/cli.ts comment|move …` (allowedTools: `Bash(node *)`),
 * inheriting the same TRELLO_* creds from the environment.
 *
 * Semantics mirror Linear: the Gene *label* marks ownership, a *list* is the
 * lifecycle state (the card's list name = stateName), and "assigned to me" filters
 * by card membership. Wrapped as `TrelloTracker` behind the neutral Tracker
 * interface (see ./index.ts). All writes honour GENE_DRY_RUN.
 */

import logger from "../logger.ts";
import { env, REPO_ROOT } from "../config.ts";
import { buildBranchName, fallbackPrefix } from "../branch.ts";
import { fetchRetryTimeout } from "../fetch.ts";
import { createTrelloClient } from "../../trello/index.ts";
import type {
  TrelloCard,
  TrelloClient,
  TrelloComment,
  TrelloLabel,
  TrelloList,
  TrelloMember
} from "../../trello/index.ts";
import type { Attachment, Comment, Issue, Tracker } from "./index.ts";
import { ensureTrelloWebhook, startTrelloWebhookListener } from "./trello/webhook.ts";

const TRELLO_API_BASE = "https://api.trello.com/1";

/** A card attachment, as Trello returns it (the wrapper deliberately omits these). */
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

// The REST client, created lazily on first use (creds are validated then, not at
// import time — so a Linear run never touches Trello creds).
let client: TrelloClient | undefined;
const trello = (): TrelloClient => {
  if (!client) {
    client = createTrelloClient();
  }
  return client;
};

// Board metadata, resolved once per process (the tracker is a singleton): the
// lists (name↔id), board members, the authenticated member, and the board name.
let boardName: string | undefined;
let listsCache: TrelloList[] | undefined;
let membersCache: TrelloMember[] | undefined;
let meCache: TrelloMember | null | undefined;
let labelsCache: TrelloLabel[] | undefined;
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
  if (listsCache && membersCache && meCache !== undefined) {
    return;
  }
  const board = boardId();
  const c = trello();
  // Members/me/boards/labels are best-effort: a missing member list just loses username
  // resolution; the lists are essential (they are the lifecycle states).
  const [lists, members, me, boards, labels] = await Promise.all([
    c.listLists(board),
    c.listMembers(board).catch(() => [] as TrelloMember[]),
    c.getMe().catch(() => null),
    c.listBoards().catch(() => []),
    c.listLabels(board).catch(() => [] as TrelloLabel[])
  ]);
  listsCache = lists;
  membersCache = members;
  meCache = me;
  labelsCache = labels;
  boardName = boards.find(b => b.id === board)?.name;
};

/** A card's list id → the list's name (the lifecycle state). */
const listName = (idList: string): string =>
  (listsCache ?? []).find(l => l.id === idList)?.name ?? "";

/** Resolve a state name to a list id — TRELLO_LIST_MAP override first, else by list name. */
const listIdForState = (stateName: string): string | null => {
  const override = parseListMap()[stateName];
  if (override) {
    return override;
  }
  const want = stateName.toLowerCase();
  return (listsCache ?? []).find(l => l.name.toLowerCase() === want)?.id ?? null;
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

/**
 * Trello cards have no native parent field, so a subcard (Shape B) records its parent
 * as a `Parent: <cardUrl>` first line in its description — the card shortLink in that URL
 * is the parent's identifier. Returns undefined for a card with no such marker.
 */
const PARENT_LINE_REGEX = /^\s*Parent:\s*\S*trello\.com\/c\/([A-Za-z0-9]{8,})/im;
export const parentIdentifierFromDesc = (desc: string): string | undefined =>
  PARENT_LINE_REGEX.exec(desc)?.[1] ?? undefined;

const toIssue = (card: TrelloCard): Issue => {
  const me = meCache;
  const usernames = usernamesFor(card.idMembers);
  const identifier = card.shortLink || card.id;
  return {
    id: card.id,
    identifier,
    title: card.name,
    description: card.desc,
    url: card.url,
    branchName: buildBranchName({ prefix: fallbackPrefix(), identifier, title: card.name }),
    stateName: listName(card.idList),
    updatedAt: card.dateLastActivity ?? "",
    assigneeName: usernames.length > 0 ? usernames.join(", ") : null,
    assigneeIsMe: me ? card.idMembers.includes(me.id) : false,
    assigneeMatch: usernames.length > 0 ? usernames.join(",") : null,
    teamKey: "",
    teamName: boardName ?? "",
    projectName: null,
    parentIdentifier: parentIdentifierFromDesc(card.desc)
  };
};

const toComment = (c: TrelloComment): Comment => ({
  id: c.id,
  body: c.text,
  createdAt: c.date,
  authorName: c.authorName ?? c.authorUsername ?? null,
  isAgent: c.text.includes(env.AGENT_MARKER)
});

/** List a card's attachments via direct REST (the wrapper doesn't cover attachments). */
const listCardAttachments = async (cardId: string): Promise<RawAttachment[]> => {
  if (!env.TRELLO_API_KEY || !env.TRELLO_TOKEN) {
    return [];
  }
  const url = new URL(`${TRELLO_API_BASE}/cards/${cardId}/attachments`);
  url.search = new URLSearchParams({
    key: env.TRELLO_API_KEY,
    token: env.TRELLO_TOKEN,
    fields: "name,url,mimeType,fileName"
  }).toString();
  const res = await fetchRetryTimeout(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Trello GET /cards/${cardId}/attachments -> ${res.status}`);
  }
  return (await res.json()) as RawAttachment[];
};

export class TrelloTracker implements Tracker {
  readonly name = "trello";

  /** All Gene-labelled cards on the board, any list (caller buckets by state = list name). */
  async listIssues(): Promise<Issue[]> {
    await ensureMeta();
    const want = env.LABEL.toLowerCase();
    const cards = await trello().listCardsOnBoard(boardId());
    return cards.filter(c => c.labels.some(l => l.name.toLowerCase() === want)).map(toIssue);
  }

  async getComments(issue: Issue): Promise<Comment[]> {
    // The wrapper returns comments oldest-first already.
    const raw = await trello().getComments(issue.id);
    return raw.map(toComment);
  }

  async getAttachments(issue: Issue): Promise<Attachment[]> {
    const raw = await listCardAttachments(issue.id);
    return raw
      .filter(a => Boolean(a.url))
      .map(a => ({ title: a.name ?? null, url: a.url as string, sourceType: a.mimeType ?? null }));
  }

  /** Image URLs to stage: the card's image attachments + any inline image links in the text. */
  async collectImageUrls(issue: Issue, comments: Comment[]): Promise<string[]> {
    const seen = new Set<string>();
    try {
      for (const a of await listCardAttachments(issue.id)) {
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

  /** Download via REST with an OAuth header (the wrapper has no download); null on failure. */
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
    await trello().addComment(issue.id, marked);
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
    await trello().moveCard(issue.id, listId);
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

  /**
   * Prompt block: how the agent comments / moves the card. The agent runs in a
   * different repo's worktree, so it invokes the bundled CLI by absolute path
   * (`node <REPO_ROOT>/trello/cli.ts …`), inheriting the TRELLO_* creds. The
   * Blocked/In-Review list ids are embedded directly when the board metadata is
   * already cached (it is — listIssues() warms it during the scan).
   */
  writeBackSnippet(issue: Issue): string {
    const cli = `node ${REPO_ROOT}/trello/cli.ts`;
    const moveLine = (state: string, id: string | null): string =>
      id
        ? `  - "${state}" → \`${cli} move ${issue.id} ${id}\``
        : `  - "${state}" → \`${cli} move ${issue.id} <listId>\` (find the list id below)`;
    return [
      "# How to write back to Trello (use the bundled trello CLI)",
      "",
      "These commands inherit your Trello credentials from the environment — run them from anywhere.",
      `This card's id is \`${issue.id}\`.`,
      "",
      `- **Comment:** \`${cli} comment ${issue.id} "<body>"\` — end every comment with the marker line`,
      "  (see Hard rules). When you open the change request, include its URL in a comment so it stays linked",
      "  to this card. Keep each comment to one focused message.",
      "- **Move state (Trello lists):** move the card to the right list. Your terminal states:",
      moveLine(env.BLOCKED_STATE, listIdForState(env.BLOCKED_STATE)),
      moveLine(env.REVIEW_STATE, listIdForState(env.REVIEW_STATE)),
      `  List every list id on the board with \`${cli} lists ${boardId()}\`.`
    ].join("\n");
  }

  /**
   * Prompt block: how the agent creates a subcard (Shape B). Trello has no native parent
   * field, so the link is a `Parent: <url>` first description line; the card must also carry
   * the Gene label, land in the trigger list, and (when ASSIGNEE=me) have the bot as a member
   * so the next scan picks it up. The label/list/member ids are resolved from the warm meta
   * cache and baked into the command (the bundled CLI takes ids straight through).
   */
  subcardSnippet(issue: Issue): string {
    const cli = `node ${REPO_ROOT}/trello/cli.ts`;
    const todoList = listIdForState(env.TRIGGER_STATE);
    const geneLabelId = (labelsCache ?? []).find(l => l.name.toLowerCase() === env.LABEL.toLowerCase())?.id;
    const meId = meCache?.id;
    const labelFlag = geneLabelId ? ` --label ${geneLabelId}` : "";
    const memberFlag = meId ? ` --member ${meId}` : "";
    return [
      "# How to split into subcards (Shape B)",
      "",
      "Create each subcard as its own Trello card that enters the normal pipeline. For each subtask:",
      `- Create the card in the trigger list (\`${env.TRIGGER_STATE}\`):`,
      "  ```",
      `  ${cli} create --list ${todoList ?? "<todoListId>"}${labelFlag}${memberFlag} \\`,
      `    --name "[${issue.identifier}] <subtask title>" \\`,
      `    --desc $'Parent: ${issue.url}` + String.raw`\n\n## Problem\n<...>\n\n## Acceptance criteria\n- [ ] <...>'`,
      "  ```",
      `  The \`--desc\` uses bash \`$'…'\` quoting so the \`\\n\` become real newlines. The \`Parent: ${issue.url}\``,
      "  first line is REQUIRED — the daemon reads it to auto-complete this parent once every subcard is done.",
      geneLabelId
        ? `  (\`--label\` applies the \`${env.LABEL}\` tag so the daemon sees the subcard; keep it.)`
        : `  IMPORTANT: also ensure the new card carries the \`${env.LABEL}\` label, or the daemon will ignore it.`,
      meId
        ? "  (`--member` assigns it to you so it's picked up; keep it.)"
        : "",
      "- After creating all subcards, post a summary comment on THIS card listing them, then move THIS",
      `  card to "${env.BLOCKED_STATE}" and exit. Do NOT open a change request for this parent.`
    ]
      .filter(line => line !== "")
      .join("\n");
  }

  allowedTools(): string[] {
    return ["Bash(node *)"];
  }

  /**
   * Real-time reactivity via a Trello board webhook. Disabled (poll-only) unless
   * GENE_WEBHOOK_URL + TRELLO_API_SECRET (and the API key/token) are set. Registers
   * the webhook if missing, then starts the HTTP listener; returns a stop function.
   * Registration failure is non-fatal — the daemon keeps polling.
   */
  async startWatch(onActivity: () => void): Promise<() => void> {
    const noop = (): void => {};
    if (!env.WEBHOOK_URL || !env.TRELLO_API_SECRET || !env.TRELLO_API_KEY || !env.TRELLO_TOKEN) {
      logger.info("[trello] webhook disabled (set GENE_WEBHOOK_URL + TRELLO_API_SECRET to enable) — poll-only");
      return noop;
    }
    try {
      await ensureTrelloWebhook(boardId(), env.WEBHOOK_URL);
    } catch (error) {
      logger.warn(
        "[trello] could not register webhook (continuing poll-only):",
        error instanceof Error ? error.message : error
      );
      return noop;
    }
    return startTrelloWebhookListener({
      port: env.WEBHOOK_PORT,
      callbackUrl: env.WEBHOOK_URL,
      secret: env.TRELLO_API_SECRET,
      onActivity
    });
  }
}
