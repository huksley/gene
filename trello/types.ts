/**
 * Trello REST API types. Two flavours per resource:
 *   - `Raw*`  — the subset of fields we read off the wire (Trello returns far more);
 *   - the normalised, hand-mapped shape the wrapper hands back to callers.
 *
 * Vocabulary note: Trello has no "issues". A Trello **card** is the unit of work,
 * so throughout this wrapper an "issue" === a card. Cards live in **lists** (their
 * status column) on a **board**.
 */

export type TrelloBoard = {
  id: string;
  name: string;
  url: string;
  /** Trello "closed" === the board is archived. */
  closed: boolean;
  desc: string;
};

export type TrelloList = {
  id: string;
  name: string;
  closed: boolean;
  idBoard: string;
  pos: number;
};

export type TrelloLabel = {
  id: string;
  name: string;
  color: string | null;
};

/** A card === an "issue" in this wrapper's vocabulary. */
export type TrelloCard = {
  id: string;
  name: string;
  desc: string;
  /** Short, shareable web URL (falls back to the canonical url). */
  url: string;
  /** Trello "closed" === archived. */
  closed: boolean;
  idBoard: string;
  /** The list (status column) the card currently sits in. */
  idList: string;
  /** ISO date string, or null when no due date is set. */
  due: string | null;
  dueComplete: boolean;
  labels: TrelloLabel[];
  shortLink: string;
  dateLastActivity: string | null;
};

/** A comment on a card (Trello models it as a `commentCard` action). */
export type TrelloComment = {
  /** The action id — needed to update or delete the comment. */
  id: string;
  text: string;
  /** ISO timestamp. */
  date: string;
  cardId: string;
  authorId: string | null;
  authorName: string | null;
  authorUsername: string | null;
};

export type CreateCardInput = {
  /** Destination list (status column). Required by Trello. */
  idList: string;
  name: string;
  desc?: string;
  /** "top" | "bottom" | a positive number. */
  pos?: "top" | "bottom" | number;
  /** ISO date string, or null. */
  due?: string | null;
  start?: string | null;
  idMembers?: string[];
  idLabels?: string[];
};

export type UpdateCardInput = {
  name?: string;
  desc?: string;
  /** Move to another list (a status change). */
  idList?: string;
  /** true === archive, false === unarchive. */
  closed?: boolean;
  pos?: "top" | "bottom" | number;
  due?: string | null;
  dueComplete?: boolean;
  idMembers?: string[];
  idLabels?: string[];
};

export type TrelloCredentials = {
  /** Trello API key (TRELLO_API_KEY). */
  key: string;
  /** Trello API token authorising a member's account (TRELLO_TOKEN). */
  token: string;
  /** Override the API base (default https://api.trello.com/1). */
  baseUrl?: string;
};

// --- Raw wire shapes (only the fields we consume) ---------------------------

export type RawBoard = {
  id: string;
  name?: string;
  url?: string;
  closed?: boolean;
  desc?: string;
};

export type RawList = {
  id: string;
  name?: string;
  closed?: boolean;
  idBoard?: string;
  pos?: number;
};

export type RawLabel = {
  id?: string;
  name?: string;
  color?: string | null;
};

export type RawCard = {
  id: string;
  name?: string;
  desc?: string;
  url?: string;
  shortUrl?: string;
  shortLink?: string;
  closed?: boolean;
  idBoard?: string;
  idList?: string;
  due?: string | null;
  dueComplete?: boolean;
  labels?: RawLabel[];
  dateLastActivity?: string | null;
};

export type RawComment = {
  id: string;
  date?: string;
  data?: { text?: string; card?: { id?: string } };
  memberCreator?: { id?: string; fullName?: string | null; username?: string | null } | null;
};
