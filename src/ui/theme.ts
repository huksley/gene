/**
 * Visual constants for the OpenTUI dashboard (src/ui/).
 *
 * Plain data — no @opentui/core import — so it can be pulled into format/test
 * code freely. Hex strings are passed straight to OpenTUI's `fg`/`bg`/
 * `backgroundColor` (which accept `ColorInput`, i.e. a hex string or RGBA).
 *
 * Only a type-only import of {@link AgentStatus} from the model, so this stays a
 * leaf of the view with no runtime coupling.
 */

import type { AgentStatus } from "../monitor.ts";

/** The dashboard color palette — a dark, GitHub-ish scheme tuned for terminals. */
export const palette = {
  /** Screen + unselected-row background. */
  bg: "#0D1117",
  /** Full-line highlight behind the focused ticket row. */
  selection: "#1F2A38",
  /** Rule/border lines. */
  border: "#2A3038",
  /** Primary body text. */
  text: "#C9D1D9",
  /** Secondary labels. */
  muted: "#6E7681",
  /** Tertiary / disabled glyphs. */
  dim: "#454C56",
  /** Brand + running agents. */
  accent: "#39C5CF",
  /** Healthy / done. */
  good: "#3FB950",
  /** Timeout / cancelled. */
  warn: "#D29922",
  /** Error. */
  bad: "#F85149",
  /** Neutral highlight (queued, links). */
  info: "#58A6FF",
  /** The [DRY-RUN] badge. */
  badge: "#D29922"
} as const;

/** Foreground color for a given agent status. */
export const statusColor = (status: AgentStatus): string => {
  switch (status) {
    case "running":
      return palette.accent;
    case "queued":
      return palette.info;
    case "done":
      return palette.good;
    case "error":
      return palette.bad;
    case "timeout":
    case "cancelled":
    case "blocked":
      return palette.warn;
    case "interrupted":
      return palette.muted; // a ghost row from a dead daemon — faded, not alarming
    case "idle":
      return palette.dim; // a program at rest — subdued
  }
};

/** A single glyph standing in for a status in the table's status column. */
export const statusGlyph = (status: AgentStatus): string => {
  switch (status) {
    case "running":
      return "•"; // overridden by the spinner on running rows
    case "queued":
      return "◦";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "timeout":
      return "⏱";
    case "cancelled":
      return "⊘";
    case "blocked":
      return "⏸"; // halted, awaiting a human reply
    case "interrupted":
      return "↯"; // run severed when its daemon was killed mid-flight
    case "idle":
      return "·"; // a program at rest between runs
  }
};

/** Upper-case status label for the detail header. */
export const statusLabel = (status: AgentStatus): string => status.toUpperCase();

/** Marks a recurring program in the dashboard's ticket column. */
export const PROGRAM_GLYPH = "⟳";

/** Braille spinner frames; advance one per animation tick on running rows. */
export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Spinner glyph for a given animation frame (handles negative/large frames). */
export const spinner = (frame: number): string => {
  const len = spinnerFrames.length;
  return spinnerFrames[((frame % len) + len) % len];
};
