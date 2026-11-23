import { useLayoutEffect, useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { relative } from "@/lib/format";
import type { CommentView } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A ticket's latest comment. With `clamp`, it's cut to a few lines (by rendered height,
 * so a short comment with a table is clamped as fairly as a long paragraph) with a
 * show-more toggle that appears only when something is actually hidden.
 */
export const LatestComment = ({ comment, clamp = true, className }: { comment?: CommentView; clamp?: boolean; className?: string }) => {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !clamp) return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 4);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [clamp, comment?.body]);

  if (!comment) {
    return <p className={cn("text-xs text-muted-foreground italic", className)}>No comments yet (or still loading).</p>;
  }
  const clamped = clamp && !open;
  return (
    <div className={cn("min-w-0 rounded-lg border bg-muted/30 p-3", className)}>
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageSquareText className="size-3.5" />
        <span>{comment.isAgent ? "Gene" : (comment.authorName ?? "Someone")}</span>
        <span>·</span>
        <span title={new Date(comment.createdAt).toLocaleString()}>{relative(comment.createdAt)}</span>
      </div>
      <div ref={body} className={cn("relative", clamped && "max-h-36 overflow-hidden")}>
        <Markdown source={comment.body} />
        {clamped && overflows && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[color-mix(in_oklab,var(--card),var(--muted)_30%)] to-transparent" />
        )}
      </div>
      {clamp && (overflows || open) && (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            setOpen(o => !o);
          }}
          className="mt-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
};
