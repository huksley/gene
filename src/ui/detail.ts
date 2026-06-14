/**
 * The per-ticket detail view, opened with `enter` from the dashboard.
 *
 * Layout (below the shared status header): a small header — when the title is
 * known, line 1 is "‹ ID ›  title" and line 2 is status/stage/repo/branch;
 * when it isn't, those collapse into one "‹ ID ›  status · stage …" line and the
 * title row is hidden. Then the pid/age/tools/tokens line, then two stacked panes —
 *
 *  - **recent actions (last 5)** — the tail of the persisted activity log
 *    (`readIssueLog` rows handed in via {@link Detail.setHistory}). Pinned: it
 *    never scrolls away, so the durable summary stays in view.
 *  - **live log** — the running agent's event stream ({@link AgentState.events}),
 *    scrollable and sticky to the tail; `↑↓`/`PgUp`/`PgDn`/`Home`/`End` scroll it.
 *    When an agent is attached but hasn't emitted events yet (queued / just
 *    dispatched) it shows a short "waiting…" placeholder — it does *not* replay
 *    the persisted history, which is already pinned in "recent actions" above.
 *    When no agent is live at all (a finished ticket browsed from the table) it
 *    falls back to the full persisted history here, so old tickets stay browsable.
 *
 * `esc` (handled by the controller) returns to the dashboard; `c` cancels the live
 * agent (or, when there's nothing to cancel, shows why for 2s); `R` resets the ticket.
 */

import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  bold,
  dim,
  fg,
  t,
  type CliRenderer
} from "@opentui/core";

import type { AgentEvent, AgentState } from "../monitor.ts";
import type { IssueLogRow } from "../db.ts";
import { compactTokens, humanDuration, truncate } from "./format.ts";
import { palette, statusColor, statusLabel } from "./theme.ts";

/** Max lines retained in the live pane (oldest dropped past this). */
const MAX_LINES = 800;

/** How many of the most-recent activity-log rows the pinned "recent actions" pane shows. */
const RECENT_ACTIONS = 5;

/** A live event rendered as a colored one-liner (mirrors the dashboard's glyphs). */
const formatLiveEvent = (event: AgentEvent): { text: string; color: string } => {
  switch (event.type) {
    case "session":
      return { text: "▶ session started", color: palette.dim };
    case "text":
      return { text: `→ ${event.text}`, color: palette.text };
    case "tool_use":
      return { text: `↳ ${event.summary}`, color: palette.accent };
    case "tool_error":
      return { text: `⚠ ${event.detail}`, color: palette.bad };
    case "result": {
      const seconds = event.durationMs != null ? (event.durationMs / 1000).toFixed(1) : "?";
      return event.subtype === "success"
        ? { text: `✓ done in ${seconds}s`, color: palette.good }
        : { text: `✗ ${event.subtype} in ${seconds}s`, color: palette.warn };
    }
  }
};

/** Run age in ms: explicit duration, else finished span, else live elapsed. */
const ageMsOf = (a: AgentState, now: number): number => {
  if (a.durationMs != null) {
    return a.durationMs;
  }
  if (a.finishedAt != null && a.startedAt != null) {
    return a.finishedAt - a.startedAt;
  }
  if (a.startedAt != null) {
    return now - a.startedAt;
  }
  return 0;
};

/** Format one activity-log row as a `time  event — detail` one-liner. */
const formatHistoryRow = (row: IssueLogRow, width: number): string => {
  const time = new Date(row.createdAt).toLocaleTimeString();
  const detail = row.detail ? ` — ${row.detail}` : "";
  return truncate(`${time}  ${row.event}${detail}`, width);
};

/** The detail renderable tree + its imperative update surface. */
export class Detail {
  /** Root container; the controller adds this to the app column and toggles `visible`. */
  readonly root: BoxRenderable;

  private renderer: CliRenderer;
  private issueTitle: TextRenderable;
  private titleLine: TextRenderable;
  private subLine: TextRenderable;
  private actionsLabel: TextRenderable;
  private actionsBox: BoxRenderable;
  private liveLabel: TextRenderable;
  private live: ScrollBoxRenderable;
  private footer: TextRenderable;

  private actionLines: TextRenderable[] = [];
  private liveLines: TextRenderable[] = [];
  private historyRows: IssueLogRow[] = [];
  private currentId: string | null = null;
  private historyLoaded = false;
  /** Which source currently fills the live pane: nothing yet / agent attached but idle / history fallback / live stream. */
  private liveMode: "pending" | "waiting" | "history" | "live" = "pending";
  private liveRendered = 0;
  private seq = 0;

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;

    // Fills the area below the shared header (header.ts); `flexGrow` so it and the
    // dashboard each take the rest of the column when their `visible` is toggled.
    this.root = new BoxRenderable(renderer, {
      id: "gene-detail",
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      backgroundColor: palette.bg,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 0
    });

    // Chrome lines: flexShrink:0 so the live pane's flexGrow can't squeeze them
    // onto the same row (they otherwise collapse into one mangled line). The ticket
    // id+title line sits above the status/stage row; the title line is hidden until a
    // title is known (then the id moves up to share that line).
    this.issueTitle = new TextRenderable(renderer, { id: "gene-detail-issue-title", content: "", flexShrink: 0 });
    this.titleLine = new TextRenderable(renderer, { id: "gene-detail-title", content: "", flexShrink: 0 });
    this.subLine = new TextRenderable(renderer, { id: "gene-detail-sub", content: "", flexShrink: 0 });
    this.root.add(this.issueTitle);
    this.root.add(this.titleLine);
    this.root.add(this.subLine);

    // Pinned "recent actions" summary: the last few persisted activity-log rows,
    // always visible (flexShrink:0) so it never scrolls away. Sits directly under
    // the pid/age/tokens line — no separator rule, to keep the header block tight.
    this.actionsLabel = new TextRenderable(renderer, { id: "gene-detail-actions-label", content: "", flexShrink: 0 });
    this.actionsBox = new BoxRenderable(renderer, {
      id: "gene-detail-actions",
      width: "100%",
      flexShrink: 0,
      flexDirection: "column"
    });
    this.root.add(this.actionsLabel);
    this.root.add(this.actionsBox);

    // Live log pane: the running agent's event stream (or the full history when no
    // agent is live), scrollable + sticky to the tail. flexGrow:1 fills the rest.
    this.liveLabel = new TextRenderable(renderer, { id: "gene-detail-live-label", content: "", flexShrink: 0 });
    this.live = new ScrollBoxRenderable(renderer, {
      id: "gene-detail-live",
      width: "100%",
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      contentOptions: { flexDirection: "column" }
    });
    this.root.add(this.liveLabel);
    this.root.add(this.live);

    this.footer = new TextRenderable(renderer, { id: "gene-detail-footer", content: "", fg: palette.muted, flexShrink: 0 });
    this.root.add(this.footer);
  }

  /** Switch to a ticket: clear both panes and show a loading placeholder until history arrives. */
  open(id: string): void {
    this.currentId = id;
    this.historyLoaded = false;
    this.historyRows = [];
    this.liveMode = "pending";
    this.liveRendered = 0;
    this.clearActions();
    this.clearLive();
    this.actionsLabel.content = this.sectionLabel(`recent actions (last ${RECENT_ACTIONS})`);
    this.liveLabel.content = this.sectionLabel("live log");
    this.addLiveLine(`Loading ${id}…`, palette.dim);
    this.live.scrollTo({ x: 0, y: 0 });
  }

  /** Install persisted history: render the last few into the pinned pane; the live pane repopulates. */
  setHistory(rows: IssueLogRow[]): void {
    this.historyRows = rows;
    this.historyLoaded = true;
    this.renderActions(rows);
    // Force the live pane to (re)populate on the next render: a running ticket
    // shows its live stream there; a finished one falls back to the full history.
    this.liveMode = "pending";
    this.liveRendered = 0;
    this.clearLive();
  }

  /**
   * Update the header + footer, refresh the pinned actions, and feed the live
   * pane (live stream if the agent is running, else the full history fallback).
   * `notice` replaces the footer hints with a one-line message (the reset-confirm
   * prompt / "resetting…" status from the controller).
   */
  render(agent: AgentState | undefined, _frame: number, now: number, notice?: string): void {
    const id = this.currentId ?? "";

    const statusText = agent ? statusLabel(agent.status) : "HISTORY";
    const statusCol = agent ? statusColor(agent.status) : palette.muted;
    const stage = agent?.stage ? `  ·  ${agent.stage}` : "";
    const repo = agent?.repoLabel ? `  ·  ${agent.repoLabel}` : "";
    const branch = agent?.branch ? `  ⎇ ${agent.branch}` : "";

    // With a known title, put the identifier alongside it on the first line and give
    // the status/stage/repo/branch the second line to itself. Without a title (live
    // agents carry it from dispatch; finished tickets recover it from the dispatch log
    // row's data, but older rows predate it), keep the single combined line and hide
    // the title row.
    if (agent?.title) {
      const titleWidth = Math.max(10, this.renderer.width - 2 - (id.length + 6));
      this.issueTitle.visible = true;
      this.issueTitle.content = t`${dim("‹")} ${bold(fg(palette.text)(id))} ${dim("›")}  ${bold(fg(palette.text)(truncate(agent.title, titleWidth)))}`;
      this.titleLine.content = t`${bold(fg(statusCol)(statusText))}${fg(palette.muted)(stage)}${fg(palette.info)(repo)}${fg(palette.accent)(branch)}`;
    } else {
      this.issueTitle.visible = false;
      this.issueTitle.content = "";
      this.titleLine.content = t`${dim("‹")} ${bold(fg(palette.text)(id))} ${dim("›")}  ${bold(fg(statusCol)(statusText))}${fg(palette.muted)(stage)}${fg(palette.info)(repo)}${fg(palette.accent)(branch)}`;
    }

    const pid = agent?.pid != null ? String(agent.pid) : "—";
    const age = agent?.startedAt != null ? humanDuration(ageMsOf(agent, now)) : "—";
    const tools = agent ? String(agent.toolCount) : "0";
    const tokens = agent?.tokens
      ? `in ${compactTokens(agent.tokens.in)} · out ${compactTokens(agent.tokens.out)}`
      : "—";
    this.subLine.content = t`${fg(palette.muted)("pid")} ${fg(palette.text)(pid)}   ${fg(palette.muted)("age")} ${fg(palette.text)(age)}   ${fg(palette.muted)("tools")} ${fg(palette.text)(tools)}   ${fg(palette.muted)("tokens")} ${fg(palette.text)(tokens)}`;

    this.footer.content = notice
      ? t`${bold(fg(palette.warn)(notice))}`
      : t`${fg(palette.muted)("↑↓")} scroll  ${fg(palette.muted)("PgUp/PgDn")}  ${fg(palette.muted)("Home/End")}  ${fg(palette.muted)("c")} cancel  ${fg(palette.muted)("r")} reset  ${fg(palette.muted)("esc")} back  ${fg(palette.muted)("q")} quit`;

    // Live pane: stream the agent's events if it has any, else fall back to the
    // full persisted history so a finished ticket stays browsable.
    if (agent && agent.events.length > 0) {
      if (this.liveMode !== "live") {
        this.clearLive();
        this.liveRendered = 0;
        this.liveMode = "live";
      }
      this.appendLiveDelta(agent);
      this.liveLabel.content = this.sectionLabel("live log");
    } else if (agent) {
      // Agent attached but no events yet (queued / just dispatched). The persisted
      // history is already pinned in "recent actions" above, so don't replay it
      // here — just wait for the stream to start (avoids a duplicated log).
      if (this.liveMode !== "waiting") {
        this.clearLive();
        this.addLiveLine("waiting for agent output…", palette.dim);
        this.liveMode = "waiting";
      }
      this.liveLabel.content = this.sectionLabel("live log (waiting…)");
    } else if (this.historyLoaded) {
      if (this.liveMode !== "history") {
        this.clearLive();
        this.renderHistoryIntoLive(this.historyRows);
        this.liveMode = "history";
      }
      this.liveLabel.content = this.sectionLabel("activity log");
    }
  }

  /** Scroll the live pane by `lines` rows (negative = up). */
  scrollByLines(lines: number): void {
    this.live.scrollBy({ x: 0, y: lines });
  }

  /** Scroll the live pane by roughly one viewport (`direction` -1 up / +1 down). */
  pageBy(direction: number): void {
    const page = Math.max(1, this.live.viewport.height - 1);
    this.live.scrollBy({ x: 0, y: direction * page });
  }

  /** Jump to the top of the live pane. */
  toTop(): void {
    this.live.scrollTo({ x: 0, y: 0 });
  }

  /** Jump to the bottom of the live pane. */
  toBottom(): void {
    this.live.scrollTo({ x: 0, y: this.live.scrollHeight });
  }

  /** A "── label ──────" section divider that fills the width. */
  private sectionLabel(text: string) {
    const lead = "── ";
    const used = lead.length + text.length + 1;
    const tail = "─".repeat(Math.max(0, this.renderer.width - 2 - used));
    return t`${fg(palette.border)(lead)}${fg(palette.muted)(text)} ${fg(palette.border)(tail)}`;
  }

  private renderActions(rows: IssueLogRow[]): void {
    this.clearActions();
    this.actionsLabel.content = this.sectionLabel(`recent actions (last ${RECENT_ACTIONS})`);
    const recent = rows.slice(-RECENT_ACTIONS);
    if (recent.length === 0) {
      this.addActionLine("no recorded actions yet", palette.dim);
      return;
    }
    const width = Math.max(10, this.renderer.width - 4);
    for (const row of recent) {
      this.addActionLine(formatHistoryRow(row, width), palette.muted);
    }
  }

  private renderHistoryIntoLive(rows: IssueLogRow[]): void {
    if (rows.length === 0) {
      this.addLiveLine("No recorded history for this ticket.", palette.dim);
      return;
    }
    const width = Math.max(10, this.renderer.width - 4);
    for (const row of rows) {
      this.addLiveLine(formatHistoryRow(row, width), palette.muted);
    }
  }

  private appendLiveDelta(agent: AgentState): void {
    const events = agent.events;
    if (events.length <= this.liveRendered) {
      return;
    }
    for (let i = this.liveRendered; i < events.length; i++) {
      const { text, color } = formatLiveEvent(events[i]);
      this.addLiveLine(text, color);
    }
    this.liveRendered = events.length;
  }

  private addLiveLine(content: string, color: string): void {
    const line = new TextRenderable(this.renderer, {
      id: `gene-detail-live-${this.seq++}`,
      content,
      fg: color
    });
    this.live.add(line);
    this.liveLines.push(line);
    if (this.liveLines.length > MAX_LINES) {
      const old = this.liveLines.shift();
      if (old) {
        this.live.remove(old.id);
        old.destroy();
      }
    }
  }

  private addActionLine(content: string, color: string): void {
    const line = new TextRenderable(this.renderer, {
      id: `gene-detail-action-${this.seq++}`,
      content,
      fg: color
    });
    this.actionsBox.add(line);
    this.actionLines.push(line);
  }

  private clearLive(): void {
    for (const line of this.liveLines) {
      this.live.remove(line.id);
      line.destroy();
    }
    this.liveLines = [];
  }

  private clearActions(): void {
    for (const line of this.actionLines) {
      this.actionsBox.remove(line.id);
      line.destroy();
    }
    this.actionLines = [];
  }
}
