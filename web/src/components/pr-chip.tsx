import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dot } from "@/components/status";
import type { SessionPr } from "@/lib/types";
import { cn } from "@/lib/utils";
import { relative } from "@/lib/format";

const CI_TONE = { success: "ok", failed: "bad", running: "warn", none: "idle" } as const;

/** A PR/MR the session opened, coloured by its live state, with a CI dot. */
export const PrChip = ({ pr }: { pr: SessionPr }) => {
  const s = pr.status;
  const Icon = !s ? GitPullRequest : s.state === "merged" ? GitMerge : s.state === "closed" ? GitPullRequestClosed : s.isDraft ? GitPullRequestDraft : GitPullRequest;
  const tone = !s
    ? "text-muted-foreground"
    : s.state === "merged"
      ? "text-violet-600 dark:text-violet-400 border-violet-500/30"
      : s.state === "closed"
        ? "text-bad border-bad/30"
        : s.isDraft
          ? "text-muted-foreground"
          : "text-ok border-ok/30";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent", tone)}
        >
          <Icon className="size-3" />
          {pr.label}
          {s && s.state === "open" && s.ci !== "none" && <Dot tone={CI_TONE[s.ci]} pulse={s.ci === "running"} className="ml-0.5 size-1.5" />}
        </a>
      </TooltipTrigger>
      <TooltipContent>
        {pr.repo ?? new URL(pr.url).pathname.split("/").slice(1, 3).join("/")} {pr.label}
        {s ? ` · ${s.isDraft && s.state === "open" ? "draft" : s.state}${s.state === "open" ? ` · CI ${s.ci}` : ""}` : " · status pending"}
        {` · opened ${relative(pr.at)}`}
      </TooltipContent>
    </Tooltip>
  );
};
