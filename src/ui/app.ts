/**
 * OpenTUI dashboard bootstrap — the view's entry point and controller.
 *
 * `index.ts` dynamically imports this only under `--ui` (so the default console
 * mode never loads @opentui/core / native FFI). {@link startUi} mounts the
 * renderer, builds the dashboard + detail trees, diverts the logger into the
 * bottom pane, wires keyboard + signal handling, seeds the table from Postgres
 * history, and finally runs the daemon's poll loop in this same process — the
 * loop is fully async (timers / network / child I/O), so render frames and
 * keypresses interleave with it cooperatively.
 *
 * Requires Node ≥ 26.3.0 launched with `--experimental-ffi`; `createCliRenderer`
 * throws otherwise, which `index.ts` catches to print install guidance.
 */

import { BoxRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";

import logger, { setLogSink, type LogSink } from "../logger.ts";
import { monitor, type AgentState, type AgentStatus } from "../monitor.ts";
import { readIssueLog, type IssueLogRow } from "../db.ts";
import { Dashboard, nextSortMode, type SortMode } from "./dashboard.ts";
import { Detail } from "./detail.ts";
import { Header } from "./header.ts";
import { palette } from "./theme.ts";

/** What the controller (index.ts) hands the UI: the daemon loop to drive + how to shut down. */
export interface StartUiOptions {
  /** Runs the daemon's scan/dispatch loop forever (resolves only on shutdown). */
  runForever: () => Promise<void>;
  /** Graceful daemon shutdown (closes the DB, reports owned locks); does not exit the process. */
  shutdown: (signal: string) => Promise<void>;
  /** Reset one ticket (worktree/branch/lock + back to Todo). Bound to `R` inside a ticket. */
  reset: (identifier: string) => Promise<void>;
}

/** Map a persisted log event name to a coarse agent status for the history table. */
const statusFromEvent = (event: string): AgentStatus =>
  event.includes("cancel")
    ? "cancelled"
    : event.includes("timeout")
      ? "timeout"
      : event.includes("done")
        ? "done"
        : event.includes("error")
          ? "error"
          : "queued";

/**
 * Synthesize browsable table rows from the global activity log so the dashboard
 * isn't empty in dry-run (and so finished tickets stay selectable). Groups rows
 * by identifier, derives a coarse status/stage/timing from the run's events, and
 * keeps the 25 most-recent. Live agents from the monitor override these by id.
 */
const buildHistorySeed = (rows: IssueLogRow[]): AgentState[] => {
  const groups = new Map<string, IssueLogRow[]>();
  for (const row of rows) {
    const list = groups.get(row.identifier);
    if (list) {
      list.push(row);
    } else {
      groups.set(row.identifier, [row]);
    }
  }

  const seed: AgentState[] = [];
  for (const [id, list] of groups) {
    const first = list[0];
    const last = list[list.length - 1];
    const dispatch = list.find(r => r.event === "dispatch");
    const startedAt = Number.isNaN(Date.parse(first.createdAt)) ? undefined : Date.parse(first.createdAt);
    const finishedAt = Number.isNaN(Date.parse(last.createdAt)) ? undefined : Date.parse(last.createdAt);
    seed.push({
      id,
      stage: dispatch?.detail ?? last.event,
      status: statusFromEvent(last.event),
      startedAt,
      finishedAt,
      lastEvent: last.detail ? `${last.event} — ${last.detail}` : last.event,
      events: [],
      toolCount: 0
    });
  }

  seed.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  return seed.slice(0, 25);
};

/** Merge live monitor agents over the history seed (live wins on identifier collision). */
const mergeAgents = (live: AgentState[], seed: AgentState[]): AgentState[] => {
  const byId = new Map<string, AgentState>();
  for (const a of seed) {
    byId.set(a.id, a);
  }
  for (const a of live) {
    byId.set(a.id, a);
  }
  return [...byId.values()];
};

/** Mount the dashboard and run the daemon loop in-process. Resolves only when the UI exits. */
export const startUi = async (options: StartUiOptions): Promise<void> => {
  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    targetFps: 30
  });
  try {
    renderer.setBackgroundColor(palette.bg);
  } catch {
    // Older terminals may reject OSC 11 — purely cosmetic, ignore.
  }

  // A column: the status header stays pinned at the top while the body below it
  // swaps between the dashboard table and a ticket's detail view. Hidden bodies
  // are display:none (yoga), so the visible one's flexGrow fills the whole area.
  const app = new BoxRenderable(renderer, {
    id: "gene-app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: palette.bg
  });
  renderer.root.add(app);

  const header = new Header(renderer);
  const dashboard = new Dashboard(renderer);
  const detail = new Detail(renderer);
  app.add(header.root);
  app.add(dashboard.root);
  app.add(detail.root);
  detail.root.visible = false;

  let view: "dashboard" | "detail" = "dashboard";
  let detailId = "";
  let selectedIndex = -1;
  let sortMode: SortMode = "status";
  let frame = 0;
  let snapshot = monitor.getState();
  let historySeed: AgentState[] = [];
  let cancelArmedId: string | null = null;
  let cancelArmedAt = 0;
  let resetArmedId: string | null = null;
  let resetArmedAt = 0;
  let resetBusyId: string | null = null;
  let detailToken = 0;
  let quitting = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const paint = (): void => {
    const now = Date.now();
    if (cancelArmedId && now - cancelArmedAt > 2000) {
      cancelArmedId = null;
    }
    if (resetArmedId && now - resetArmedAt > 2000) {
      resetArmedId = null;
    }
    const agents = mergeAgents(snapshot.agents, historySeed);
    const merged = { daemon: snapshot.daemon, agents, tokens: snapshot.tokens };
    // The status header is pinned at the top, above whichever body is shown.
    header.render(merged, now);
    if (view === "dashboard") {
      detail.root.visible = false;
      dashboard.root.visible = true;
      const notice = cancelArmedId ? `Press c again within 2s to cancel ${cancelArmedId}` : undefined;
      dashboard.render(merged, { selectedIndex, frame, now, sort: sortMode, notice });
    } else {
      dashboard.root.visible = false;
      detail.root.visible = true;
      const notice =
        resetBusyId === detailId
          ? `Resetting ${detailId}…`
          : resetArmedId === detailId
            ? `Press R again within 2s to reset ${detailId} — removes worktree/branch, back to Todo`
            : undefined;
      detail.render(agents.find(a => a.id === detailId), frame, now, notice);
    }
  };

  const onChange = (): void => {
    snapshot = monitor.getState();
    paint();
  };
  monitor.on("change", onChange);

  // Divert the logger into the bottom pane so it never corrupts the alt-screen.
  const logSink: LogSink = {
    push: record => {
      try {
        dashboard.appendLog(record);
      } catch {
        // A render hiccup must not break logging.
      }
    }
  };
  const previousSink = setLogSink(logSink);

  // Seed the table from Postgres history (best-effort; pg may not be up yet).
  const reseed = async (): Promise<void> => {
    try {
      historySeed = buildHistorySeed(await readIssueLog());
    } catch {
      // DB unavailable — keep whatever seed we have and let live agents fill in.
    }
    paint();
  };

  const moveSelection = (delta: number): void => {
    const count = dashboard.getOrderedIds().length;
    if (count === 0) {
      selectedIndex = -1;
      return;
    }
    selectedIndex = selectedIndex < 0 ? (delta > 0 ? 0 : count - 1) : Math.min(count - 1, Math.max(0, selectedIndex + delta));
  };

  /** (Re)load a ticket's persisted history into the detail body; newest token wins. */
  const loadDetailHistory = (id: string): void => {
    const token = ++detailToken;
    void readIssueLog(snapshot.daemon.tracker, id)
      .then(rows => {
        if (token === detailToken && view === "detail" && detailId === id) {
          detail.setHistory(rows);
          paint();
        }
      })
      .catch(() => {
        if (token === detailToken && view === "detail" && detailId === id) {
          detail.setHistory([]);
          paint();
        }
      });
  };

  const openDetail = (): void => {
    const ids = dashboard.getOrderedIds();
    if (selectedIndex < 0 || selectedIndex >= ids.length) {
      return;
    }
    detailId = ids[selectedIndex];
    view = "detail";
    detail.open(detailId);
    loadDetailHistory(detailId);
  };

  const armCancel = (): void => {
    const ids = dashboard.getOrderedIds();
    if (selectedIndex < 0 || selectedIndex >= ids.length) {
      return;
    }
    const id = ids[selectedIndex];
    const agent = monitor.getAgent(id);
    if (!agent || agent.status !== "running") {
      return;
    }
    const now = Date.now();
    if (cancelArmedId === id && now - cancelArmedAt <= 2000) {
      monitor.requestCancel(id);
      cancelArmedId = null;
    } else {
      cancelArmedId = id;
      cancelArmedAt = now;
    }
  };

  /** Reset the open ticket; double-press R within 2s confirms (mirrors armCancel). */
  const armReset = (): void => {
    if (view !== "detail" || !detailId || resetBusyId) {
      return;
    }
    const now = Date.now();
    if (resetArmedId === detailId && now - resetArmedAt <= 2000) {
      const id = detailId;
      resetArmedId = null;
      void doReset(id);
    } else {
      resetArmedId = detailId;
      resetArmedAt = now;
    }
  };

  /** Cancel any live agent for the ticket, run the reset, then reload its history. */
  const doReset = async (id: string): Promise<void> => {
    resetBusyId = id;
    paint();
    // If an agent is live, ask it to stop first so reset can remove its worktree.
    const agent = monitor.getAgent(id);
    if (agent && agent.status === "running") {
      monitor.requestCancel(id);
    }
    try {
      await options.reset(id);
    } catch (error) {
      logger.error("reset failed:", error instanceof Error ? error.message : error);
    } finally {
      resetBusyId = null;
    }
    // Refresh the detail body (shows the new "reset" event) and the dashboard seed
    // (so the row reflects the reset when you return).
    if (view === "detail" && detailId === id) {
      detail.open(id);
      loadDetailHistory(id);
    }
    void reseed();
    paint();
  };

  const quit = async (): Promise<void> => {
    if (quitting) {
      return;
    }
    quitting = true;
    if (timer) {
      clearInterval(timer);
    }
    monitor.off("change", onChange);
    setLogSink(previousSink);
    try {
      renderer.destroy();
    } catch {
      // best-effort terminal restore
    }
    try {
      await options.shutdown("UI");
    } catch {
      // shutdown is itself best-effort
    }
    process.exit(0);
  };

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") {
      void quit();
      return;
    }
    if (view === "detail") {
      switch (key.name) {
        case "escape":
          view = "dashboard";
          paint();
          return;
        case "q":
          void quit();
          return;
        case "up":
        case "k":
          detail.scrollByLines(-1);
          paint();
          return;
        case "down":
        case "j":
          detail.scrollByLines(1);
          paint();
          return;
        case "pageup":
          detail.pageBy(-1);
          paint();
          return;
        case "pagedown":
          detail.pageBy(1);
          paint();
          return;
        case "home":
          detail.toTop();
          paint();
          return;
        case "end":
          detail.toBottom();
          paint();
          return;
        case "r":
          // `R` (and lowercase r — no other binding in this view) resets the ticket.
          armReset();
          paint();
          return;
        default:
          return;
      }
    }
    switch (key.name) {
      case "q":
        void quit();
        return;
      case "up":
      case "k":
        moveSelection(-1);
        paint();
        return;
      case "down":
      case "j":
        moveSelection(1);
        paint();
        return;
      case "return":
      case "right":
        openDetail();
        paint();
        return;
      case "s": {
        // Cycle the sort, keeping the same ticket selected across the re-order.
        const ids = dashboard.getOrderedIds();
        const selId = selectedIndex >= 0 && selectedIndex < ids.length ? ids[selectedIndex] : null;
        sortMode = nextSortMode(sortMode);
        paint(); // re-sorts the table and refreshes getOrderedIds()
        if (selId) {
          selectedIndex = dashboard.getOrderedIds().indexOf(selId);
        }
        paint();
        return;
      }
      case "c":
        armCancel();
        paint();
        return;
      case "r":
        void reseed();
        return;
      case "escape":
        selectedIndex = -1;
        paint();
        return;
      default:
        return;
    }
  });

  renderer.on("resize", () => paint());
  process.on("SIGINT", () => void quit());
  process.on("SIGTERM", () => void quit());

  // Animation tick: advance the spinner + countdown and repaint a few times a second.
  timer = setInterval(() => {
    frame = (frame + 1) & 0xffff;
    paint();
  }, 120);

  await reseed();
  paint();

  // Run the daemon loop in this process; it resolves only when the daemon stops.
  try {
    await options.runForever();
  } catch (error) {
    logger.error("daemon loop exited:", error instanceof Error ? error.message : error);
  }
};
