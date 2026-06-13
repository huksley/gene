/**
 * The main dashboard screen: a live table of running/recent tickets (full-line
 * selection, tracker-initial prefix, spinner) plus a tail of the daemon log. The
 * status block above it lives in {@link ./header.ts} — the controller mounts that
 * once so it persists when you open a ticket — so this module owns only the table
 * and log.
 *
 * It exposes a small imperative surface to {@link ./app.ts}: {@link Dashboard.render}
 * (called on every state change and animation tick), {@link Dashboard.appendLog},
 * and {@link Dashboard.getOrderedIds} (so the controller can map the selected row
 * index back to an issue identifier). It is the only place — together with
 * detail.ts and header.ts — that imports @opentui/core, so the daemon core never
 * touches FFI.
 */

import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  bold,
  dim,
  fg,
  t,
  type CliRenderer,
  type StyledText
} from "@opentui/core";

import type { AgentState, AgentStatus, MonitorSnapshot } from "../monitor.ts";
import { formatRecord, type LogRecord } from "../logger.ts";
import { fit, humanDuration, stripAnsi, truncate } from "./format.ts";
import { palette, spinner, statusColor, statusGlyph } from "./theme.ts";

/** Fixed table column widths (characters). The EVENT column flexes to fill the rest. */
const COL = { tracker: 1, id: 10, state: 11, glyph: 1, stage: 16, pid: 7, age: 8, tools: 5 } as const;

/** Columns + the single-space separators between them, up to (not including) EVENT. */
const FIXED_WIDTH =
  COL.tracker + 1 + COL.id + 1 + COL.state + 1 + COL.glyph + 1 + COL.stage + 1 + COL.pid + 1 + COL.age + 1 + COL.tools + 1;

/** The dim column-label row, built from the same widths so it aligns with the data rows. */
const TABLE_HEADER = [
  fit("", COL.tracker),
  fit("ID", COL.id),
  fit("STATE", COL.state),
  fit("", COL.glyph),
  fit("STAGE", COL.stage),
  fit("PID", COL.pid),
  fit("AGE", COL.age),
  fit("TOOLS", COL.tools),
  "EVENT"
].join(" ");

/** Max log lines kept in the bottom pane (oldest dropped past this). */
const MAX_LOG_LINES = 400;

/**
 * How the ticket table is ordered, cycled by `s`:
 *  - `status` — running (oldest first) → queued → finished (most-recent first); the default.
 *  - `age`    — longest-running / oldest first, regardless of status.
 *  - `id`     — by ticket identifier (e.g. CLOUD-1094), alphabetical.
 */
export type SortMode = "status" | "age" | "id";

/** Short label shown in the footer for the active sort. */
export const sortLabel = (mode: SortMode): string =>
  mode === "status" ? "status" : mode === "age" ? "age" : "id";

/** Next sort in the cycle, driven by the `s` key. */
export const nextSortMode = (mode: SortMode): SortMode =>
  mode === "status" ? "age" : mode === "age" ? "id" : "status";

/** Options the controller passes into {@link Dashboard.render} each frame. */
export interface RenderOptions {
  /** Highlighted row index, or -1 when no row is selected (the initial state). */
  selectedIndex: number;
  /** Monotonic animation frame, advanced by the controller's timer (drives the spinner). */
  frame: number;
  /** Current epoch ms (passed in so age/uptime/countdown share one clock per frame). */
  now: number;
  /** Active sort order for the table. */
  sort: SortMode;
  /** When true, tickets in the tracker's Done state are hidden from the table. Shown by default. */
  hideDone?: boolean;
  /** Optional one-line notice shown in the footer instead of the key hints (e.g. cancel confirm). */
  notice?: string;
}

/** A status's sort bucket: running first, then queued, then everything terminal. */
const statusRank = (status: AgentStatus): number =>
  status === "running" ? 0 : status === "queued" ? 1 : 2;

/** Run age in ms: explicit duration if known, else finished span, else live elapsed. */
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

/** Order rows per {@link SortMode}. `status` is the default bucketed order. */
const sortAgents = (agents: AgentState[], mode: SortMode, now: number): AgentState[] => {
  if (mode === "id") {
    return [...agents].sort((a, b) => a.id.localeCompare(b.id));
  }
  if (mode === "age") {
    return [...agents].sort((a, b) => ageMsOf(b, now) - ageMsOf(a, now));
  }
  return [...agents].sort((a, b) => {
    const byRank = statusRank(a.status) - statusRank(b.status);
    if (byRank !== 0) {
      return byRank;
    }
    if (statusRank(a.status) === 2) {
      return (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
    }
    return (a.startedAt ?? 0) - (b.startedAt ?? 0);
  });
};

/** Build the styled, fixed-width content for one ticket row. */
const rowLine = (
  a: AgentState,
  frame: number,
  now: number,
  trackerInitial: string,
  selected: boolean,
  eventWidth: number
): StyledText => {
  const glyph = a.status === "running" ? spinner(frame) : statusGlyph(a.status);
  const pid = a.pid != null ? String(a.pid) : "—";
  const age = a.startedAt != null ? humanDuration(ageMsOf(a, now)) : "—";
  const tools = a.toolCount > 0 ? String(a.toolCount) : "—";
  const eventColor =
    a.status === "error" ? palette.bad : a.status === "running" ? palette.text : palette.muted;

  const idCell = fit(a.id, COL.id);
  const idChunk = selected ? bold(fg("#FFFFFF")(idCell)) : fg(palette.text)(idCell);

  const state = fit(a.lifecycleState ?? "—", COL.state);
  return t`${dim(fit(trackerInitial, COL.tracker))} ${idChunk} ${fg(palette.info)(state)} ${fg(statusColor(a.status))(fit(glyph, COL.glyph))} ${fg(palette.muted)(fit(a.stage, COL.stage))} ${fg(palette.dim)(fit(pid, COL.pid))} ${fg(palette.muted)(fit(age, COL.age))} ${fg(palette.dim)(fit(tools, COL.tools))} ${fg(eventColor)(truncate(a.lastEvent, eventWidth))}`;
};

/** One reusable table row: a full-width Box (for the highlight) wrapping one Text. */
class Row {
  readonly box: BoxRenderable;
  private label: TextRenderable;

  constructor(renderer: CliRenderer, index: number) {
    this.label = new TextRenderable(renderer, { id: `gene-row-${index}-label`, content: "", selectable: false });
    this.box = new BoxRenderable(renderer, {
      id: `gene-row-${index}`,
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: palette.bg
    });
    this.box.add(this.label);
  }

  set(content: StyledText, selected: boolean): void {
    this.box.backgroundColor = selected ? palette.selection : palette.bg;
    this.label.content = content;
  }

  setVisible(visible: boolean): void {
    this.box.visible = visible;
  }
}

/** The dashboard renderable tree + its imperative update surface. */
export class Dashboard {
  /** Root container; the controller adds this to `renderer.root`. */
  readonly root: BoxRenderable;

  private renderer: CliRenderer;
  private tableHead: TextRenderable;
  private rowsBox: BoxRenderable;
  private placeholder: TextRenderable;
  private logBox: ScrollBoxRenderable;
  private footer: TextRenderable;

  private rows: Row[] = [];
  private logLines: TextRenderable[] = [];
  private orderedIds: string[] = [];
  private logSeq = 0;

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;

    // Fills the area below the shared header (header.ts), which the controller
    // mounts above both this and the detail view; `flexGrow` so it takes the rest.
    this.root = new BoxRenderable(renderer, {
      id: "gene-dashboard",
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      backgroundColor: palette.bg,
      paddingLeft: 1,
      paddingRight: 1
    });

    // flexShrink:0 so the flexGrow rows area can't collapse the head/footer rows.
    this.tableHead = new TextRenderable(renderer, { id: "gene-thead", content: TABLE_HEADER, fg: palette.muted, flexShrink: 0 });
    this.root.add(this.tableHead);

    this.rowsBox = new BoxRenderable(renderer, {
      id: "gene-rows",
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      overflow: "hidden"
    });
    this.placeholder = new TextRenderable(renderer, {
      id: "gene-empty",
      content: "  No tasks yet — waiting for the next scan…",
      fg: palette.dim
    });
    this.rowsBox.add(this.placeholder);
    this.root.add(this.rowsBox);

    this.logBox = new ScrollBoxRenderable(renderer, {
      id: "gene-log",
      width: "100%",
      height: 9,
      flexShrink: 0,
      border: ["top"],
      borderColor: palette.border,
      title: " daemon log ",
      titleColor: palette.muted,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      contentOptions: { flexDirection: "column" }
    });
    this.root.add(this.logBox);

    this.footer = new TextRenderable(renderer, { id: "gene-footer", content: "", fg: palette.muted, flexShrink: 0 });
    this.root.add(this.footer);
  }

  /** Issue identifiers in the order rows are currently displayed (selection ↔ id map). */
  getOrderedIds(): string[] {
    return this.orderedIds;
  }

  /** Update the whole dashboard from a snapshot + per-frame options. Cheap; no tree churn. */
  render(snapshot: MonitorSnapshot, options: RenderOptions): void {
    const { selectedIndex, frame, now, sort, hideDone, notice } = options;
    const d = snapshot.daemon;
    const width = this.renderer.width;

    // "Done" means the ticket's tracker state equals the configured Done state (the
    // STATE column), not the agent's run status — a finished run can still sit in
    // In Review. With no Done state configured there's nothing to hide.
    const visible =
      hideDone && d.doneState ? snapshot.agents.filter(a => a.lifecycleState !== d.doneState) : snapshot.agents;
    const sorted = sortAgents(visible, sort, now);
    this.orderedIds = sorted.map(a => a.id);
    this.placeholder.visible = sorted.length === 0;

    const eventWidth = Math.max(10, width - 2 - FIXED_WIDTH);
    while (this.rows.length < sorted.length) {
      const row = new Row(this.renderer, this.rows.length);
      this.rowsBox.add(row.box);
      this.rows.push(row);
    }
    for (let i = 0; i < this.rows.length; i++) {
      if (i < sorted.length) {
        const selected = i === selectedIndex;
        this.rows[i].setVisible(true);
        this.rows[i].set(rowLine(sorted[i], frame, now, d.trackerInitial, selected, eventWidth), selected);
      } else {
        this.rows[i].setVisible(false);
      }
    }

    this.footer.content = notice
      ? t`${bold(fg(palette.warn)(notice))}`
      : t`${fg(palette.muted)("↑↓")} select  ${fg(palette.muted)("enter")} open  ${fg(palette.muted)("s")} sort:${fg(palette.text)(sortLabel(sort))}  ${fg(palette.muted)("d")} done:${fg(palette.text)(hideDone ? "hidden" : "shown")}  ${fg(palette.muted)("c")} cancel  ${fg(palette.muted)("r")} refresh  ${fg(palette.muted)("q")} quit`;
  }

  /** Append one log record to the bottom pane (sticky-scrolled to the tail). */
  appendLog(record: LogRecord): void {
    const line = stripAnsi(formatRecord(record));
    const color =
      record.level === "error"
        ? palette.bad
        : record.level === "warn"
          ? palette.warn
          : record.level === "debug"
            ? palette.dim
            : palette.text;
    const text = new TextRenderable(this.renderer, {
      id: `gene-log-${this.logSeq++}`,
      content: line,
      fg: color
    });
    this.logBox.add(text);
    this.logLines.push(text);
    if (this.logLines.length > MAX_LOG_LINES) {
      const old = this.logLines.shift();
      if (old) {
        this.logBox.remove(old.id);
        old.destroy();
      }
    }
  }
}
