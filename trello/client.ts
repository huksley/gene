/**
 * A tiny, dependency-free Trello REST API wrapper (Node 18+ global `fetch`).
 *
 * Auth: Trello requires BOTH an API key and a token on every authenticated
 * request — the key identifies the app, the token authorises a member's account.
 * A key on its own gets a 401. We read TRELLO_API_KEY + TRELLO_TOKEN (see
 * trello/README.md for how to mint them) and attach them as `key`/`token` query
 * params on each call.
 *
 * Scope: manage cards (this wrapper's "issues") and their comments. The board/
 * list helpers exist so you can discover the ids the card methods need.
 *
 * Reads send params in the query string; writes send them as a urlencoded body
 * (so long descriptions / comments don't bump into URL-length limits), with
 * `key`/`token` always in the query string.
 */

import type {
  CreateCardInput,
  RawBoard,
  RawCard,
  RawComment,
  RawList,
  RawMember,
  TrelloBoard,
  TrelloCard,
  TrelloComment,
  TrelloCredentials,
  TrelloList,
  TrelloMember,
  UpdateCardInput
} from "./types.ts";

const DEFAULT_BASE_URL = "https://api.trello.com/1";

/** Thrown on any non-2xx Trello response, carrying the status + body for triage. */
export class TrelloApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: string;

  constructor(method: string, path: string, status: number, body: string) {
    super(`Trello ${method} ${path} -> ${status}: ${body.slice(0, 500) || "(empty body)"}`);
    this.name = "TrelloApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

type ParamValue = string | number | boolean | string[] | null | undefined;

/** Build query/form params: arrays -> comma-joined, drop undefined, keep explicit null as "". */
const toParams = (record: Record<string, ParamValue>): URLSearchParams => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      params.set(key, "");
      continue;
    }
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return params;
};

const toBoard = (raw: RawBoard): TrelloBoard => ({
  id: raw.id,
  name: raw.name ?? "(unnamed board)",
  url: raw.url ?? "",
  closed: raw.closed ?? false,
  desc: raw.desc ?? ""
});

const toList = (raw: RawList): TrelloList => ({
  id: raw.id,
  name: raw.name ?? "(unnamed list)",
  closed: raw.closed ?? false,
  idBoard: raw.idBoard ?? "",
  pos: typeof raw.pos === "number" ? raw.pos : 0
});

const toCard = (raw: RawCard): TrelloCard => ({
  id: raw.id,
  name: raw.name ?? "(untitled)",
  desc: raw.desc ?? "",
  url: raw.shortUrl ?? raw.url ?? "",
  closed: raw.closed ?? false,
  idBoard: raw.idBoard ?? "",
  idList: raw.idList ?? "",
  due: raw.due ?? null,
  dueComplete: raw.dueComplete ?? false,
  labels: (raw.labels ?? []).map(l => ({ id: l.id ?? "", name: l.name ?? "", color: l.color ?? null })),
  idMembers: raw.idMembers ?? [],
  shortLink: raw.shortLink ?? "",
  dateLastActivity: raw.dateLastActivity ?? null
});

const toMember = (raw: RawMember): TrelloMember => ({
  id: raw.id,
  username: raw.username ?? null,
  fullName: raw.fullName ?? null
});

const toComment = (raw: RawComment): TrelloComment => ({
  id: raw.id,
  text: raw.data?.text ?? "",
  date: raw.date ?? "",
  cardId: raw.data?.card?.id ?? "",
  authorId: raw.memberCreator?.id ?? null,
  authorName: raw.memberCreator?.fullName ?? null,
  authorUsername: raw.memberCreator?.username ?? null
});

export class TrelloClient {
  private readonly key: string;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(creds: TrelloCredentials) {
    if (!creds.key || !creds.token) {
      throw new Error(
        "TrelloClient needs both an API key and a token. " +
          "Set TRELLO_API_KEY and TRELLO_TOKEN (see trello/README.md)."
      );
    }
    this.key = creds.key;
    this.token = creds.token;
    this.baseUrl = (creds.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  /** Build a client from TRELLO_API_KEY / TRELLO_TOKEN (+ optional TRELLO_API_BASE_URL). */
  static fromEnv(source: NodeJS.ProcessEnv = process.env): TrelloClient {
    const key = source.TRELLO_API_KEY?.trim();
    const token = source.TRELLO_TOKEN?.trim();
    const missing: string[] = [];
    if (!key) {
      missing.push("TRELLO_API_KEY");
    }
    if (!token) {
      missing.push("TRELLO_TOKEN");
    }
    if (missing.length > 0) {
      throw new Error(
        `Missing ${missing.join(" + ")}. Trello needs an API key AND a token; ` +
          "see trello/README.md for how to mint them."
      );
    }
    return new TrelloClient({
      key: key as string,
      token: token as string,
      baseUrl: source.TRELLO_API_BASE_URL?.trim() || undefined
    });
  }

  /** Core request: injects auth, serialises params, throws TrelloApiError on non-2xx. */
  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, ParamValue>; form?: Record<string, ParamValue> } = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.search = toParams({ ...opts.query, key: this.key, token: this.token }).toString();

    const init: RequestInit = { method, headers: { Accept: "application/json" } };
    if (opts.form) {
      // A URLSearchParams body makes fetch set application/x-www-form-urlencoded.
      init.body = toParams(opts.form);
    }

    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) {
      throw new TrelloApiError(method, path, res.status, text);
    }
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      // A few endpoints return a bare string; hand it back unparsed.
      return text as unknown as T;
    }
  }

  // --- Boards & lists (discovery) -------------------------------------------

  /** Boards the authorised member can see. */
  async listBoards(): Promise<TrelloBoard[]> {
    const raw = await this.request<RawBoard[]>("GET", "/members/me/boards", {
      query: { fields: "name,url,closed,desc" }
    });
    return raw.map(toBoard);
  }

  /** Lists (status columns) on a board; open lists only unless includeClosed. */
  async listLists(boardId: string, includeClosed = false): Promise<TrelloList[]> {
    const raw = await this.request<RawList[]>("GET", `/boards/${boardId}/lists`, {
      query: { filter: includeClosed ? "all" : "open", fields: "name,closed,idBoard,pos" }
    });
    return raw.map(toList);
  }

  // --- Members --------------------------------------------------------------

  /** The authenticated member (whose token this is) — for the "assigned to me" check. */
  async getMe(): Promise<TrelloMember> {
    const raw = await this.request<RawMember>("GET", "/members/me", {
      query: { fields: "id,username,fullName" }
    });
    return toMember(raw);
  }

  /** Members of a board — to resolve a card's idMembers to usernames. */
  async listMembers(boardId: string): Promise<TrelloMember[]> {
    const raw = await this.request<RawMember[]>("GET", `/boards/${boardId}/members`, {
      query: { fields: "id,username,fullName" }
    });
    return raw.map(toMember);
  }

  // --- Cards (issues) -------------------------------------------------------

  /** Cards on a board (issues). Open cards only unless includeClosed. */
  async listCardsOnBoard(boardId: string, includeClosed = false): Promise<TrelloCard[]> {
    const raw = await this.request<RawCard[]>("GET", `/boards/${boardId}/cards`, {
      query: { filter: includeClosed ? "all" : "open" }
    });
    return raw.map(toCard);
  }

  /** Cards in a single list (issues in one status column). */
  async listCardsInList(listId: string): Promise<TrelloCard[]> {
    const raw = await this.request<RawCard[]>("GET", `/lists/${listId}/cards`);
    return raw.map(toCard);
  }

  /** Fetch one card by id (or shortLink). */
  async getCard(cardId: string): Promise<TrelloCard> {
    const raw = await this.request<RawCard>("GET", `/cards/${cardId}`);
    return toCard(raw);
  }

  /** Create a card (open an issue) in a list. */
  async createCard(input: CreateCardInput): Promise<TrelloCard> {
    const raw = await this.request<RawCard>("POST", "/cards", {
      form: {
        idList: input.idList,
        name: input.name,
        desc: input.desc,
        pos: input.pos,
        due: input.due,
        start: input.start,
        idMembers: input.idMembers,
        idLabels: input.idLabels
      }
    });
    return toCard(raw);
  }

  /** Update a card (edit fields, move list, set due, archive...). */
  async updateCard(cardId: string, changes: UpdateCardInput): Promise<TrelloCard> {
    const raw = await this.request<RawCard>("PUT", `/cards/${cardId}`, {
      form: {
        name: changes.name,
        desc: changes.desc,
        idList: changes.idList,
        closed: changes.closed,
        pos: changes.pos,
        due: changes.due,
        dueComplete: changes.dueComplete,
        idMembers: changes.idMembers,
        idLabels: changes.idLabels
      }
    });
    return toCard(raw);
  }

  /** Move a card to another list (change its status column). */
  moveCard(cardId: string, idList: string): Promise<TrelloCard> {
    return this.updateCard(cardId, { idList });
  }

  /** Archive a card (Trello's "close"). Reversible via unarchiveCard. */
  archiveCard(cardId: string): Promise<TrelloCard> {
    return this.updateCard(cardId, { closed: true });
  }

  /** Unarchive a previously archived card. */
  unarchiveCard(cardId: string): Promise<TrelloCard> {
    return this.updateCard(cardId, { closed: false });
  }

  /** Permanently delete a card. Irreversible — prefer archiveCard. */
  async deleteCard(cardId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/cards/${cardId}`);
  }

  // --- Comments -------------------------------------------------------------

  /**
   * Read a card's comments, oldest-first. Trello caps a single page at 1000
   * actions; pass a smaller `limit` to fetch fewer. (Cards with >1000 comments
   * are rare; paginating past that isn't implemented.)
   */
  async getComments(cardId: string, limit = 1000): Promise<TrelloComment[]> {
    const raw = await this.request<RawComment[]>("GET", `/cards/${cardId}/actions`, {
      query: { filter: "commentCard", limit }
    });
    return raw.map(toComment).sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Add a comment to a card. Returns the created comment. */
  async addComment(cardId: string, text: string): Promise<TrelloComment> {
    const raw = await this.request<RawComment>("POST", `/cards/${cardId}/actions/comments`, {
      form: { text }
    });
    return toComment(raw);
  }

  /** Edit an existing comment (identified by its action id). */
  async updateComment(cardId: string, commentId: string, text: string): Promise<TrelloComment> {
    const raw = await this.request<RawComment>("PUT", `/cards/${cardId}/actions/${commentId}/comments`, {
      form: { text }
    });
    return toComment(raw);
  }

  /** Delete a comment (identified by its action id). */
  async deleteComment(cardId: string, commentId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/cards/${cardId}/actions/${commentId}/comments`);
  }
}

/** Convenience factory mirroring TrelloClient.fromEnv(). */
export const createTrelloClient = (source: NodeJS.ProcessEnv = process.env): TrelloClient =>
  TrelloClient.fromEnv(source);
