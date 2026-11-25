import { createContext, useContext, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { cn } from "@/lib/utils";
import { splitTicketRefs } from "../../../src/web/ticket-url.ts";

DOMPurify.addHook("afterSanitizeAttributes", node => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * What ticket references (`CORE-512`) in comment text link to: listed tickets' own URLs,
 * else `base` + identifier. Only references whose team key is in `keys` are linked.
 */
export type TicketRefs = { keys: string[]; base?: string; urls: ReadonlyMap<string, string> };

export const TicketRefsContext = createContext<TicketRefs | null>(null);

/**
 * Turn ticket references in sanitized HTML's text into links, leaving text inside links
 * and code alone. Runs after DOMPurify; the hrefs it adds come from the daemon, not from
 * the comment.
 */
const linkTicketRefs = (html: string, refs: TicketRefs | null): string => {
  if (!refs || refs.keys.length === 0) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);

  for (const text of texts) {
    if (text.parentElement?.closest("a, code, pre")) continue;
    const parts = splitTicketRefs(text.data, refs.keys);
    if (parts.length === 1 && typeof parts[0] === "string") continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (typeof part === "string") {
        fragment.append(part);
        continue;
      }
      const url = refs.urls.get(part.identifier) ?? (refs.base ? `${refs.base}${part.identifier}` : undefined);
      if (!url) {
        fragment.append(part.identifier);
        continue;
      }
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = part.identifier;
      fragment.append(a);
    }
    text.replaceWith(fragment);
  }
  return template.innerHTML;
};

/** Tracker comment markdown, rendered and sanitized (comments are user content). */
export const Markdown = ({ source, className }: { source: string; className?: string }) => {
  const refs = useContext(TicketRefsContext);
  const html = useMemo(
    () => linkTicketRefs(DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: true })), refs),
    [source, refs]
  );
  return <div className={cn("prose-comment", className)} dangerouslySetInnerHTML={{ __html: html }} />;
};
