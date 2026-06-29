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

import { BoxRenderable, createCliRenderer, type CliRenderer, type KeyEvent, type Selection } from "@opentui/core";

import logger, { setLogSink, type LogSink } from "../logger.ts";
import { monitor, DONE_STAGE, type AgentState, type AgentStatus } from "../monitor.ts";
import { readIssueLog, type IssueLogRow } from "../db.ts";
import { Dashboard, nextSortMode, type SortMode } from "./dashboard.ts";
import { Detail } from "./detail.ts";
import { Header } from "./header.ts";
import { palette, statusLabel } from "./theme.ts";

/** What the controller (index.ts) hands the UI: the daemon loop to drive + how to shut down. */
export interface StartUiOptions {
  /** Runs the daemon's scan/dispatch loop forever (resolves only on shutdown). */
  runForever: () => Promise<void>;
  /**
   * Close any runs orphaned by a previous shutdown (writes their `agent-interrupted`
   * event). Run off the first frame, then followed by a reseed so the freshly-closed
   * rows replace their stale `agent-start` in the table. Best-effort; never throws.
   */
  reconcile: () => Promise<void>;
  /** Wake the poll loop so the next scan starts now (bound to `r` on the dashboard). */
  requestScan: () => void;
  /**
   * Pause or resume the scan loop (bound to `p` on the dashboard). While paused the
   * daemon stops polling the tracker for new work, but in-flight agents keep running.
   * `r` (refresh) also resumes via `setPaused(false)`.
   */
  setPaused: (paused: boolean) => void;
  /** Graceful daemon shutdown (closes the DB, reports owned locks); does not exit the process. */
  shutdown: (signal: string) => Promise<void>;
  /** Reset one ticket (worktree/branch/lock + back to Todo). Bound to `R` inside a ticket. */
  reset: (identifier: string) => Promise<void>;
}

/**
 * Map a persisted log event name to a coarse agent status for the history table.
 * `merged` is the lifecycle end (CR merged → Done), so it maps to `done` like
 * `agent-done`. `stalled` / `clarification` move the issue to Blocked awaiting a
 * human reply, so they map to `blocked`. `agent-start` as the *last* event means a
 * run whose daemon died before recording any outcome — a seed row is never a live
 * agent (the monitor overrides live ones by id in mergeAgents), so a lingering
 * `agent-start` is by definition an interrupted run, not a fresh `queued` one.
 * Anything else unrecognised falls through to `queued` (a just-dispatched run).
 */
const statusFromEvent = (event: string): AgentStatus =>
  event.includes("cancel")
    ? "cancelled"
    : event.includes("timeout")
      ? "timeout"
      : event.includes("done") || event.includes("merged")
        ? "done"
        : event.includes("error")
          ? "error"
          : event.includes("stall") || event.includes("clarification")
            ? "blocked"
            : event === "agent-start" || event.includes("interrupt")
              ? "interrupted"
              : "queued";

/**
 * Pull `stage` / `repoLabel` / `branch` back out of a persisted `dispatch` log
 * detail — the inverse of how index.ts writes it:
 *   "<intent> → <repo> [<forge>] ⎇ <branch>"
 * so a finished ticket's detail header mirrors the live one. The `⎇ <branch>`
 * tail is optional (older rows predate it); on no match the whole string is the
 * stage, matching the previous behaviour.
 */
const parseDispatchDetail = (detail: string): { stage: string; repoLabel?: string; branch?: string } => {
  const match = /^(.*?)\s*→\s*(.+?)\s*\[[^\]]*\](?:\s*⎇\s*(.+))?$/.exec(detail);
  if (!match) {
    return { stage: detail };
  }
  return { stage: match[1], repoLabel: match[2], branch: match[3] };
};

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
    const dispatch = list.findLast(r => r.event === "dispatch");
    const parsed = dispatch ? parseDispatchDetail(dispatch.detail) : undefined;
    // The dispatch row persists the issue title in its `data` JSONB (index.ts).
    const title =
      dispatch && dispatch.data && typeof dispatch.data === "object" && "title" in dispatch.data
        ? String((dispatch.data as { title: unknown }).title)
        : undefined;
    const startedAt = Number.isNaN(Date.parse(first.createdAt)) ? undefined : Date.parse(first.createdAt);
    const finishedAt = Number.isNaN(Date.parse(last.createdAt)) ? undefined : Date.parse(last.createdAt);
    seed.push({
      id,
      title,
      // A merged CR is the lifecycle end (→ Done), so its row shows the terminal
      // `done` stage rather than the stale dispatch intent — matching the live daemon.
      stage: last.event === "merged" ? DONE_STAGE : (parsed?.stage ?? last.event),
      status: statusFromEvent(last.event),
      startedAt,
      finishedAt,
      lastEvent: last.detail ? `${last.event} — ${last.detail}` : last.event,
      events: [],
      toolCount: 0,
      repoLabel: parsed?.repoLabel,
      branch: parsed?.branch
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
  let hideDone = false; // done tickets are shown by default; `d` toggles them off
  let frame = 0;
  let snapshot = monitor.getState();
  let historySeed: AgentState[] = [];
  let cancelArmedId: string | null = null;
  let cancelArmedAt = 0;
  // A short-lived footer message explaining why a cancel could not be armed (e.g.
  // nothing running for the ticket) — cleared after 2s by paint(), like the arms.
  let cancelNotice: string | null = null;
  let cancelNoticeAt = 0;
  let resetArmedId: string | null = null;
  let resetArmedAt = 0;
  let resetBusyId: string | null = null;
  let quitArmedAt = 0; // when q was pressed while agents are still running (double-press to confirm)
  let detailToken = 0;
  let quitting = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const paint = (): void => {
    const now = Date.now();
    if (cancelArmedId && now - cancelArmedAt > 2000) {
      cancelArmedId = null;
    }
    if (cancelNotice && now - cancelNoticeAt > 2000) {
      cancelNotice = null;
    }
    if (resetArmedId && now - resetArmedAt > 2000) {
      resetArmedId = null;
    }
    if (quitArmedAt && now - quitArmedAt > 2000) {
      quitArmedAt = 0;
    }
    // Stamp the live tracker state (from the daemon's per-scan side-map) onto every
    // row — live and seed alike — so the STATE column is populated for reconstructed
    // rows too, not just this session's live agents.
    const agents = mergeAgents(snapshot.agents, historySeed).map(a => {
      const lifecycleState = monitor.getIssueState(a.id) ?? a.lifecycleState;
      return lifecycleState === a.lifecycleState ? a : { ...a, lifecycleState };
    });
    const merged = { daemon: snapshot.daemon, agents, tokens: snapshot.tokens };
    // The status header is pinned at the top, above whichever body is shown.
    header.render(merged, now);
    if (view === "dashboard") {
      detail.root.visible = false;
      dashboard.root.visible = true;
      const notice = quitArmedAt
        ? "Agents still running — press q again within 2s to quit, or Q to quit now"
        : undefined;
      dashboard.render(merged, { selectedIndex, frame, now, sort: sortMode, hideDone, notice });
    } else {
      dashboard.root.visible = false;
      detail.root.visible = true;
      const notice = quitArmedAt
        ? "Agents still running — press q again within 2s to quit, or Q to quit now"
        : resetBusyId === detailId
          ? `Resetting ${detailId}…`
          : resetArmedId === detailId
            ? `Press r again within 2s to reset ${detailId} — removes worktree/branch, moves it back to Todo`
            : cancelArmedId === detailId
              ? `Press c again within 2s to cancel ${detailId}`
              : cancelNotice ?? undefined;
      detail.render(agents.find(a => a.id === detailId), frame, now, notice);
    }
  };

  const onChange = (): void => {
    snapshot = monitor.getState();
    paint();
  };
  monitor.on("change", onChange);

  /**
   * Force a clean full repaint before swapping the body (dashboard ⇆ detail).
   * OpenTUI's per-frame composite is incremental, so flipping `visible` can leave
   * artifacts from the view we just hid; clearing the back buffer to the bg wipes
   * them. `setBackgroundColor` is the public lever for this (it clears
   * `nextRenderBuffer` + requests a render) — `resize()` no-ops at unchanged
   * dimensions, and `forceFullRepaintRequested` isn't exposed.
   */
  const forceRedraw = (): void => {
    try {
      renderer.setBackgroundColor(palette.bg);
    } catch {
      // Older terminals may reject the clear's OSC — purely cosmetic, ignore.
    }
  };

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
    forceRedraw();
  };

  /**
   * Cancel the open ticket's live agent; double-press `c` within 2s confirms (mirrors
   * armReset). When there's nothing to cancel (no live agent, or it isn't running),
   * surface why in the footer for 2s instead of silently swallowing the key.
   */
  const armCancel = (): void => {
    const id = detailId;
    if (!id) {
      return;
    }
    const agent = monitor.getAgent(id);
    if (!agent || agent.status !== "running") {
      cancelNotice = agent
        ? `Can't cancel ${id} — it isn't running (${statusLabel(agent.status)})`
        : `Can't cancel ${id} — no live agent for it`;
      cancelNoticeAt = Date.now();
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

  /**
   * Quit, but guard against losing in-flight work: if any agent is still running,
   * the first `q` arms a confirmation (footer notice) and a second `q` within 2s
   * quits. `force` (Shift+Q) always quits immediately. With nothing running, plain
   * `q` quits straight away too.
   */
  const requestQuit = (force: boolean): void => {
    if (force || !snapshot.agents.some(a => a.status === "running")) {
      void quit();
      return;
    }
    const now = Date.now();
    if (quitArmedAt && now - quitArmedAt <= 2000) {
      quitArmedAt = 0;
      void quit();
    } else {
      quitArmedAt = now;
      paint();
    }
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

  // Mouse-drag selection → system clipboard. Mouse tracking is on, so the terminal's
  // own copy can't see a drag; bridge OpenTUI's selection to the clipboard via OSC 52
  // (works over SSH too). ⌘C isn't deliverable to a TUI on macOS, so selecting *is* the
  // copy. Terminals without OSC 52 support silently no-op.
  renderer.on("selection", (selection: Selection) => {
    const text = selection.getSelectedText();
    if (text && renderer.isOsc52Supported()) {
      renderer.copyToClipboardOSC52(text);
    }
  });

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") {
      void quit();
      return;
    }
    if (view === "detail") {
      switch (key.name) {
        case "escape":
          // Dismiss a lingering drag-selection highlight too: the renderer keeps the
          // selection (and repaints it every frame) until cleared, so forceRedraw alone
          // can't wipe it — clearSelection notifies the touched renderables to repaint
          // without the highlight. No-op when nothing is selected.
          renderer.clearSelection();
          view = "dashboard";
          forceRedraw();
          paint();
          return;
        case "q":
          requestQuit(key.shift); // Shift+Q quits immediately, even with agents running
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
          // `R` (and lowercase r) resets the ticket.
          armReset();
          paint();
          return;
        case "c":
          // `c` cancels the ticket's live agent (or explains for 2s why it can't).
          armCancel();
          paint();
          return;
        default:
          return;
      }
    }
    switch (key.name) {
      case "q":
        requestQuit(key.shift); // Shift+Q quits immediately, even with agents running
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
      case "d": {
        // Hiding Done needs a configured Done state to match rows against; with none,
        // the footer hides the toggle, so the key is a no-op too (rather than flipping
        // an invisible flag that filters nothing).
        if (!snapshot.daemon.doneState) {
          return;
        }
        // Toggle finished tickets, keeping the same ticket selected if it survives the filter.
        const ids = dashboard.getOrderedIds();
        const selId = selectedIndex >= 0 && selectedIndex < ids.length ? ids[selectedIndex] : null;
        hideDone = !hideDone;
        paint(); // re-filters the table and refreshes getOrderedIds()
        selectedIndex = selId ? dashboard.getOrderedIds().indexOf(selId) : -1;
        paint();
        return;
      }
      case "p":
        // Toggle the scan loop's pause: paused stops new tracker polling (in-flight
        // agents keep running); the monitor "change" it fires repaints the badge/footer.
        options.setPaused(!snapshot.daemon.paused);
        return;
      case "r":
        options.setPaused(false); // refresh also resumes if paused
        options.requestScan(); // wake the poll loop so the next scan starts now
        void reseed();
        return;
      case "escape":
        // Drop a lingering drag-selection highlight (from copy-to-clipboard): the
        // renderer holds the selection and repaints it every frame until cleared, so
        // forceRedraw — which only clears the back buffer — can't wipe it. clearSelection
        // tells the touched renderables to repaint without the highlight; no-op if none.
        renderer.clearSelection();
        // Also drop the table-row selection and force a clean redraw. paint() alone is
        // incremental, so it can't wipe artifacts left by a resize or a stray write —
        // forceRedraw() clears the back buffer first.
        selectedIndex = -1;
        forceRedraw();
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

  // Close any runs orphaned by a previous shutdown, then reseed so their rows show
  // as `interrupted` rather than the stale `agent-start` the first seed captured.
  // Non-blocking: a cold DB must not hold up the first frame (reconcile itself never
  // throws), and the reseed lands as soon as the closing events are written.
  void options.reconcile().then(reseed);

  // Run the daemon loop in this process; it resolves only when the daemon stops.
  try {
    await options.runForever();
  } catch (error) {
    logger.error("daemon loop exited:", error instanceof Error ? error.message : error);
  }
};
