/**
 * Tracker links built from a ticket identifier alone: for runs of tickets the daemon no
 * longer lists, and for ticket references in comment text. Pure, no imports — the
 * daemon (overview.ts) and the browser bundle (web/src/components/markdown.tsx) share it.
 */

const LINEAR_ISSUE_URL = /^https:\/\/linear\.app\/([^/?#]+)\/issue\//;

/** `https://linear.app/acme/issue/A-1/…` → `acme`; anything else → undefined. */
export const linearWorkspaceOf = (url: string | null | undefined): string | undefined =>
  url ? LINEAR_ISSUE_URL.exec(url)?.[1] : undefined;

/** What an identifier is appended to for its URL; only Linear has such a prefix. */
export const ticketUrlBase = (tracker: string, linearWorkspace: string | undefined): string | undefined =>
  tracker === "linear" && linearWorkspace ? `https://linear.app/${linearWorkspace}/issue/` : undefined;

/** A ticket's URL from its identifier (Linear needs the workspace; Trello shortLinks resolve as is). */
export const ticketUrl = (tracker: string, identifier: string, linearWorkspace: string | undefined): string | undefined => {
  if (tracker === "trello") return `https://trello.com/c/${identifier}`;
  const base = ticketUrlBase(tracker, linearWorkspace);
  return base ? `${base}${identifier}` : undefined;
};

/** `CORE-512` → `CORE`; identifiers without a team key (Trello shortLinks) → undefined. */
export const teamKeyOf = (identifier: string): string | undefined => /^([A-Z][A-Z0-9]*)-\d+$/.exec(identifier)?.[1];

export type TextPart = string | { identifier: string };

/**
 * Split text around ticket references (`CORE-512`) whose team key is one of `keys`, so
 * `UTF-8` and the like stay text. A reference must stand alone: not glued to a word, a
 * path (`a/CORE-1`) or a branch name (`CORE-1-fix`).
 */
export const splitTicketRefs = (text: string, keys: readonly string[]): TextPart[] => {
  if (keys.length === 0) return [text];
  const alternatives = [...keys].sort((a, b) => b.length - a.length).map(k => k.replace(/[^A-Z0-9]/g, ""));
  const re = new RegExp(`(?<![\\w/.-])(?:${alternatives.join("|")})-\\d+(?![\\w-])`, "g");
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(re)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ identifier: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : [text];
};
