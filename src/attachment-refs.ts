/**
 * Parsing of stageable attachment references out of issue/comment markdown — shared
 * by the trackers (linear.ts / trello.ts) and consumed by attachments.ts. Kept in a
 * leaf module (no tracker imports) so both sides can use it without an import cycle.
 *
 * The subtlety this exists for: a tracker's upload URL often carries NO file
 * extension (Linear serves files behind extension-less UUID paths), so the only
 * place the filename/extension appears is the markdown link *label* —
 * `[design.md](https://uploads.linear.app/…/<uuid>)`. We therefore look at the label
 * first, falling back to the URL for bare links (e.g. inline images that do carry
 * an extension). The label also gives us a real filename to stage the bytes under.
 */

/** One referenced attachment: where to download it, and a suggested filename if known. */
export type AttachmentRef = {
  url: string;
  /** Original filename from the markdown label / tracker metadata, when available. */
  fileName?: string;
};

/**
 * Extensions worth staging into the worktree: images (Claude reads them via vision)
 * plus text/doc formats the agent can open with the Read tool. Binaries it can't
 * usefully read inline (pdf, zip, …) are deliberately left out.
 */
export const STAGEABLE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg|md|markdown|txt|csv|json|ya?ml|log)(\?|#|$)/i;

/** True when `name` (a filename or URL) ends in a stageable extension. */
export const isStageableName = (name: string): boolean => STAGEABLE_EXT.test(name);

// Markdown link / image: `[label](url)` or `![alt](url)`. The label is group 1, the
// URL group 2. Both stop at the first `)` / whitespace, matching how the URL scanners
// elsewhere delimit links in prose.
const MD_LINK_PATTERN = /!?\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g;
// A bare URL not wrapped in markdown link syntax.
const BARE_URL_PATTERN = /https?:\/\/[^\s)\]"'`<>]+/g;

/**
 * Collect stageable attachment refs from a block of markdown/prose. `urlOk` gates
 * which URLs count (e.g. only `uploads.linear.app`). A markdown link is staged when
 * its *label* or its URL ends in a stageable extension (the label carries the name
 * for extension-less upload URLs); a bare URL is staged when the URL itself does.
 * Deduplicated by URL, with the label-derived filename preferred.
 */
export const collectAttachmentRefsFromText = (
  text: string,
  urlOk: (url: string) => boolean
): AttachmentRef[] => {
  const byUrl = new Map<string, AttachmentRef>();

  for (const match of text.matchAll(MD_LINK_PATTERN)) {
    const label = (match[1] ?? "").trim();
    const url = match[2]!;
    if (!urlOk(url)) {
      continue;
    }
    const labelHasExt = isStageableName(label);
    if (labelHasExt || isStageableName(url)) {
      byUrl.set(url, { url, fileName: labelHasExt ? label : byUrl.get(url)?.fileName });
    }
  }

  for (const match of text.matchAll(BARE_URL_PATTERN)) {
    const url = match[0];
    if (!urlOk(url) || byUrl.has(url) || !isStageableName(url)) {
      continue;
    }
    byUrl.set(url, { url });
  }

  return [...byUrl.values()];
};
