import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { cn } from "@/lib/utils";

DOMPurify.addHook("afterSanitizeAttributes", node => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Tracker comment markdown, rendered and sanitized (comments are user content). */
export const Markdown = ({ source, className }: { source: string; className?: string }) => {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: true })),
    [source]
  );
  return <div className={cn("prose-comment", className)} dangerouslySetInnerHTML={{ __html: html }} />;
};
