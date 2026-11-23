import { ExternalLink, GitPullRequest } from "lucide-react";
import { cn } from "@/lib/utils";
import { linkLabel } from "@/lib/format";

/** The ticket identifier, linking to the tracker when the URL is known. */
export const TicketLink = ({ identifier, url, className }: { identifier: string; url?: string; className?: string }) =>
  url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className={cn("font-mono text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-2 inline-flex items-center gap-1", className)}
    >
      {identifier}
      <ExternalLink className="size-3 opacity-60" />
    </a>
  ) : (
    <span className={cn("font-mono text-xs text-muted-foreground", className)}>{identifier}</span>
  );

export const CrLink = ({ url }: { url: string }) => (
  <a
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    onClick={e => e.stopPropagation()}
    title={url}
    className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
  >
    <GitPullRequest className="size-3" />
    {linkLabel(url)}
  </a>
);
