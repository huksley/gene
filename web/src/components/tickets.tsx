import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OutcomeBadge, StateBadge, Dot } from "@/components/status";
import { CrLink, TicketLink } from "@/components/links";
import { LatestComment } from "@/components/comment";
import { relative } from "@/lib/format";
import type { TicketView } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATE_ORDER = ["progress", "block", "review", "todo"];
const rank = (state: string): number => {
  const i = STATE_ORDER.findIndex(s => state.toLowerCase().includes(s));
  return i === -1 ? STATE_ORDER.length : i;
};

export const Tickets = ({ tickets }: { tickets: TicketView[] }) => {
  const [open, setOpen] = useState<string | null>(null);
  if (tickets.length === 0) {
    return <Card className="items-center py-12 text-sm text-muted-foreground">No tickets.</Card>;
  }
  const sorted = [...tickets].sort((a, b) => rank(a.state) - rank(b.state) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return (
    <>
      <Card className="gap-0 divide-y overflow-hidden py-0 md:hidden">
        {sorted.map(t => (
          <TicketItem key={t.identifier} t={t} />
        ))}
      </Card>
      <Card className="hidden overflow-hidden py-0 md:flex">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-8" />
            <TableHead>Ticket</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="hidden md:table-cell">Last run</TableHead>
            <TableHead className="hidden sm:table-cell">Change request</TableHead>
            <TableHead className="text-right">Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map(t => {
            const last = t.runs[0];
            const live = t.agent && (t.agent.status === "running" || t.agent.status === "queued");
            const isOpen = open === t.identifier;
            return (
              <Fragment key={t.identifier}>
                <TableRow className="cursor-pointer" onClick={() => setOpen(isOpen ? null : t.identifier)} data-state={isOpen ? "selected" : undefined}>
                  <TableCell>
                    <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  </TableCell>
                  <TableCell className="max-w-[28rem] whitespace-normal">
                    <div className="flex items-center gap-2">
                      {live && <Dot tone="run" pulse />}
                      <span className="line-clamp-1 font-medium">{t.title}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <TicketLink identifier={t.identifier} url={t.url} />
                      {t.project && <span className="truncate">· {t.project}</span>}
                    </div>
                  </TableCell>
                  <TableCell><StateBadge state={t.state} /></TableCell>
                  <TableCell className="hidden md:table-cell">
                    {last ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <OutcomeBadge outcome={last.outcome} />
                        <span>{last.intent}</span>
                        <span>· {relative(last.startedAt)}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{t.changeRequest ? <CrLink url={t.changeRequest} /> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{relative(t.updatedAt)}</TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell />
                    <TableCell colSpan={5} className="whitespace-normal pb-4">
                      {t.agent && (
                        <p className="mb-2 font-mono text-xs text-muted-foreground">
                          {t.agent.status} · {t.agent.stage} · {t.agent.lastEvent}
                        </p>
                      )}
                      <LatestComment comment={t.latestComment} clamp={false} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
      </Card>
    </>
  );
};

/** Phone: title first, the facts underneath; tap for the latest comment. */
const TicketItem = ({ t }: { t: TicketView }) => {
  const [open, setOpen] = useState(false);
  const last = t.runs[0];
  const live = t.agent && (t.agent.status === "running" || t.agent.status === "queued");
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} className="flex w-full items-start gap-2.5 px-4 py-3 text-left active:bg-muted/50" aria-expanded={open}>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="flex items-start gap-2 text-sm font-medium leading-snug">
            {live && <Dot tone="run" pulse className="mt-1.5" />}
            <span className="line-clamp-2">{t.title}</span>
          </p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
            <TicketLink identifier={t.identifier} url={t.url} />
            <StateBadge state={t.state} />
            {last && <OutcomeBadge outcome={last.outcome} />}
            {t.changeRequest && <CrLink url={t.changeRequest} />}
            <span>{relative(t.updatedAt)}</span>
          </div>
        </div>
        <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-2 px-4 pb-4">
          {last && (
            <p className="text-xs text-muted-foreground">
              Last run: {last.intent} · {relative(last.startedAt)}
              {last.detail && <> · <span className="font-mono">{last.detail}</span></>}
            </p>
          )}
          {t.agent && (
            <p className="font-mono text-xs break-words text-muted-foreground">
              {t.agent.status} · {t.agent.stage} · {t.agent.lastEvent}
            </p>
          )}
          <LatestComment comment={t.latestComment} />
        </div>
      )}
    </div>
  );
};
