/**
 * The persistent status header — the Symphony-style top block shared by both
 * views. It shows the daemon identity + dry-run badge, the running/queued agent
 * counts against the concurrency cap, uptime / current stage / next-refresh
 * countdown, cumulative tokens, and the latest scan's state breakdown, closed by a
 * full-width rule.
 *
 * The controller (app.ts) mounts this once, above both the dashboard table and the
 * ticket detail body, and calls {@link Header.render} every frame — so the status
 * block stays put when you open a ticket (esc returns under the same header). Like
 * the rest of src/ui/ it is one of the few modules that imports @opentui/core.
 */

import { BoxRenderable, StyledText, TextRenderable, bold, dim, fg, t, type CliRenderer } from "@opentui/core";

import { AgentStatuses, type AgentStatus, type DaemonState, type MonitorSnapshot } from "../monitor.ts";
import { compactTokens, humanDuration, progressBar, secondsUntil, truncate } from "./format.ts";
import { palette, statusColor, statusGlyph, statusLabel } from "./theme.ts";
import { readVersion } from "../sea-assets.ts";

/** Build version (e.g. "1.1.2"), resolved once at load — it never changes at runtime. */
const VERSION = readVersion();

/** The status header renderable tree + its imperative update surface. */
export class Header {
  /** Root container; the controller adds this to the app column, above both bodies. */
  readonly root: BoxRenderable;

  private renderer: CliRenderer;
  private titleLine: TextRenderable;
  private agentsLine: TextRenderable;
  private stageLine: TextRenderable;
  private tokensLine: TextRenderable;
  private scanLine: TextRenderable;
  private explainStatus: BoxRenderable;
  private rule: TextRenderable;

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;

    this.root = new BoxRenderable(renderer, {
      id: "gene-header",
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
      backgroundColor: palette.bg,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 0
    });

    this.titleLine = new TextRenderable(renderer, { id: "gene-title", content: "" });
    this.agentsLine = new TextRenderable(renderer, { id: "gene-agents", content: "" });
    this.stageLine = new TextRenderable(renderer, { id: "gene-stage", content: "" });
    this.tokensLine = new TextRenderable(renderer, { id: "gene-tokens", content: "" });
    this.scanLine = new TextRenderable(renderer, { id: "gene-scan", content: "" });
    this.root.add(this.titleLine);
    this.root.add(this.agentsLine);
    this.root.add(this.stageLine);
    this.root.add(this.tokensLine);
    this.root.add(this.scanLine);
    this.rule = new TextRenderable(renderer, { id: "gene-rule", content: "", fg: palette.border });
    this.explainStatus = new BoxRenderable(renderer, {
      id: "gene-explain-status",
      flexDirection: "row",
      alignItems: "center",
      columnGap: 1
    })
    this.explainStatus.add(new TextRenderable(renderer, {
      id: "gene-explain-status-label",
      content: t`${fg(palette.muted)("Legend:")}`,
    }))
    for (const status of AgentStatuses) {
      this.explainStatus.add(new TextRenderable(renderer, {
        id: "gene-explain-status-item",
        content: t`${fg(statusColor(status))(statusGlyph(status))} ${fg(palette.dim)(statusLabel(status))}`,
      }))
    }
    this.root.add(this.explainStatus);
    this.root.add(this.rule);
  }

  /** Repaint the status block from a snapshot + the shared per-frame clock. */
  render(snapshot: MonitorSnapshot, now: number): void {
    const d: DaemonState = snapshot.daemon;
    const width = this.renderer.width;

    this.titleLine.content = d.dryRun
      ? t`${fg(palette.accent)("🧬")} ${bold(fg(palette.accent)("GENE AI"))} ${fg(palette.muted)(VERSION)}  ${dim("·")}  ${fg(palette.info)(`${d.tracker}/${d.label}`)}  ${dim("·")}  ${fg(palette.muted)("assignee:")} ${d.assignee}   ${bold(fg(palette.badge)("[DRY-RUN]"))}`
      : t`${fg(palette.accent)("🧬")} ${bold(fg(palette.accent)("GENE AI"))} ${fg(palette.muted)(VERSION)}  ${dim("·")}  ${fg(palette.info)(`${d.tracker}/${d.label}`)}  ${dim("·")}  ${fg(palette.muted)("assignee:")} ${d.assignee}`;

    const running = snapshot.agents.filter(a => a.status === "running").length;
    const queued = snapshot.agents.filter(a => a.status === "queued").length;
    this.agentsLine.content = queued > 0
      ? t`${fg(palette.muted)("Agents:")}  ${bold(fg(running > 0 ? palette.accent : palette.text)(`${running}/${d.maxConcurrent}`))} running  ${dim("·")}  ${fg(palette.info)(`${queued} queued`)}`
      : t`${fg(palette.muted)("Agents:")}  ${bold(fg(running > 0 ? palette.accent : palette.text)(`${running}/${d.maxConcurrent}`))} running`;

    const uptime = humanDuration(now - d.startedAt);
    const phaseLabel = d.phase === "scanning" ? "scanning…" : d.phase === "starting" ? "starting…" : "idle";
    const phaseColor = d.phase === "scanning" ? palette.accent : palette.text;
    if (d.paused) {
      // Paused: the scan loop is idle (no next scan to count down to), but agents keep
      // running. Make it loud, and point at the keys that resume.
      this.stageLine.content = t`${fg(palette.muted)("Uptime:")} ${fg(palette.text)(uptime)}    ${fg(palette.muted)("Stage:")} ${bold(fg(palette.badge)("PAUSED"))} ${fg(palette.dim)("— scan loop idle, agents still running (p/r to resume)")}`;
    } else if (d.nextScanAt != null && d.lastScanAt != null && d.phase !== "scanning") {
      const remain = secondsUntil(d.nextScanAt, now);
      const ratio = (now - d.lastScanAt) / Math.max(1, d.pollIntervalMs);
      this.stageLine.content = t`${fg(palette.muted)("Uptime:")} ${fg(palette.text)(uptime)}    ${fg(palette.muted)("Stage:")} ${fg(phaseColor)(phaseLabel)}    ${fg(palette.muted)("Next:")} ${fg(palette.text)(`${remain}s`)} ${fg(palette.accent)(progressBar(ratio, 6))}`;
    } else {
      this.stageLine.content = t`${fg(palette.muted)("Uptime:")} ${fg(palette.text)(uptime)}    ${fg(palette.muted)("Stage:")} ${fg(phaseColor)(phaseLabel)}`;
    }

    const tk = snapshot.tokens;
    this.tokensLine.content = tk.total > 0
      ? t`${fg(palette.muted)("Tokens:")} in ${fg(palette.text)(compactTokens(tk.in))} ${dim("·")} out ${fg(palette.text)(compactTokens(tk.out))} ${dim("·")} total ${bold(fg(palette.good)(compactTokens(tk.total)))}`
      : t`${fg(palette.muted)("Tokens:")} ${fg(palette.dim)("—")}`;

    if (d.lastError) {
      this.scanLine.content = t`${fg(palette.bad)("Scan error:")} ${fg(palette.warn)(truncate(d.lastError, Math.max(10, width - 14)))}`;
    } else if (d.lastScan) {
      const s = d.lastScan;
      // When auto-Done is configured, give Done its own lane (labelled with the
      // configured state name) instead of folding those tickets into "other".
      this.scanLine.content = d.doneState
        ? t`${fg(palette.muted)("Scan:")} Todo ${fg(palette.text)(String(s.trigger))} ${dim("·")} In Progress ${fg(palette.text)(String(s.active))} ${dim("·")} Blocked ${fg(palette.text)(String(s.blocked))} ${dim("·")} In Review ${fg(palette.text)(String(s.review))} ${dim("·")} ${d.doneState} ${fg(palette.good)(String(s.done))}`
        : t`${fg(palette.muted)("Scan:")} Todo ${fg(palette.text)(String(s.trigger))} ${dim("·")} In Progress ${fg(palette.text)(String(s.active))} ${dim("·")} Blocked ${fg(palette.text)(String(s.blocked))} ${dim("·")} In Review ${fg(palette.text)(String(s.review))}`;
    } else {
      this.scanLine.content = t`${fg(palette.muted)("Scan:")} ${fg(palette.dim)("(pending first scan)")}`;
    }

    this.rule.content = "─".repeat(Math.max(0, width - 2));
  }
}
