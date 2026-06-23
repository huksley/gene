/* eslint-disable no-console */
// First import in the graph: load gene.config + .gene.config into the environment
// (env wins) before any module — including this logger — reads a GENE_* value.
import "./bootstrap.ts";
import chalk from "chalk";
import { format } from "node:util";

/**
 * Minimal server-side logger (Node-only — no browser branch). Each line is
 * prefixed with an ISO timestamp and the level so the daemon's long-running
 * output stays greppable.
 *
 * By default every call prints to the console. Install a sink with
 * `setLogSink()` to divert records off-screen instead — the foundation for an
 * alternate text UI: the same stream can drive the free-flowing log we print
 * today or, later, a rich TUI that owns the screen. A `LogCollector` is the
 * batteries-included sink that buffers records in memory.
 *
 * Usage:
 *   import logger from "./logger.ts";
 *   logger.info("...");
 *   if (logger.isVerbose) logger.verbose("...");
 *
 *   // capture instead of print:
 *   const { records } = await withLogCollector(async () => doWork());
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** A single emitted log line, captured verbatim so a renderer can format it later. */
export interface LogRecord {
  level: LogLevel;
  /** The raw args passed to the logger method — may hold chalk-colored strings, objects, or Errors. */
  args: unknown[];
  /** Epoch milliseconds at emit time. */
  timestamp: number;
}

/** A destination for log records. Install one with `setLogSink` to take over output. */
export interface LogSink {
  push: (record: LogRecord) => void;
}

export interface Logger {
  isVerbose: boolean;
  tag: {
    db: string;
    flow: string;
    invoke: string;
    review: string;
    reset: string;
    log: string;
    lock: string;
    fetch: string;
    ignore: string;
    tracker: string;
    forge: string;
    config: string;
    clone: string;
    attachments: string;
    trello: string;
    linear: string;
    update: string;
    export: string;
  };
  verbose: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Colorized level label, shared by the console prefix and {@link formatRecord}. */
const colorLevel = (level: LogLevel): string => {
  switch (level) {
    case "debug":
      return chalk.dim("DEBUG");
    case "info":
      return chalk.white("INFO");
    case "warn":
      return chalk.yellow("WARN");
    case "error":
      return chalk.red("ERROR");
  }
};

/** Lazily stringifies to a timestamped prefix at the moment the line is logged. */
class Level {
  private readonly level: LogLevel;

  constructor(level: LogLevel) {
    this.level = level;
  }

  toString(): string {
    return `${chalk.gray(new Date().toLocaleTimeString())} ${colorLevel(this.level)}`;
  }

  [Symbol.toPrimitive](hint: string): string | undefined {
    return hint === "string" ? this.toString() : undefined;
  }
}

/**
 * Render a captured record back to a single console-style line: the same
 * `<time> <LEVEL> <message>` shape the console path prints, but using the
 * record's own timestamp. Both the flowing-log replay and a future TUI lean on
 * this so formatting lives in exactly one place.
 */
export const formatRecord = (record: LogRecord): string => {
  const time = chalk.gray(new Date(record.timestamp).toLocaleTimeString());
  return `${time} ${colorLevel(record.level)} ${format(...record.args)}`;
};

// The active sink. null => write straight to the console (default behavior).
// A module-level binding is the Node-native stand-in for the browser code's
// globalThis.__logCollector: this module is a singleton, so one process shares
// one sink.
let sink: LogSink | null = null;

/** Install (or with `null`, remove) the sink that receives every record. Returns the previous sink. */
export const setLogSink = (next: LogSink | null): LogSink | null => {
  const previous = sink;
  sink = next;
  return previous;
};

/** The currently installed sink, or null when logging straight to the console. */
export const getLogSink = (): LogSink | null => sink;

const emit = (
  level: LogLevel,
  consoleFn: (...args: unknown[]) => void,
  levelTag: Level,
  args: unknown[]
): void => {
  if (sink) {
    sink.push({ level, args, timestamp: Date.now() });
    return;
  }
  consoleFn("%s", levelTag, ...args);
};

/**
 * A {@link LogSink} that buffers records in memory instead of printing them.
 * Bounded so a long-running daemon can't grow it without limit — once full it
 * drops the oldest records (a ring buffer).
 */
export class LogCollector implements LogSink {
  private records: LogRecord[] = [];
  private readonly max: number;

  constructor(opts: { max?: number } = {}) {
    this.max = Math.max(1, opts.max ?? 10_000);
  }

  push(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.max) {
      this.records.splice(0, this.records.length - this.max);
    }
  }

  /** Buffered records, oldest first. Live view — does not clear. */
  snapshot(): readonly LogRecord[] {
    return this.records;
  }

  /** Return all buffered records and empty the buffer. */
  drain(): LogRecord[] {
    const out = this.records;
    this.records = [];
    return out;
  }

  clear(): void {
    this.records = [];
  }

  get size(): number {
    return this.records.length;
  }
}

/**
 * Run `fn` with log output diverted into a fresh {@link LogCollector} instead of
 * the console, restoring the previous sink afterwards (even if `fn` throws).
 * Single-sink: a nested call captures into its own collector and restores the
 * outer one on exit.
 */
export const withLogCollector = async <T>(
  fn: (collector: LogCollector) => T | Promise<T>
): Promise<{ result: T; collector: LogCollector }> => {
  const collector = new LogCollector();
  const previous = setLogSink(collector);
  try {
    const result = await fn(collector);
    return { result, collector };
  } finally {
    setLogSink(previous);
  }
};

const verbose = process.env.GENE_LOG_VERBOSE === "1" || process.env.LINEAR_DEBUG === "1";

const debugTag = new Level("debug");
const infoTag = new Level("info");
const warnTag = new Level("warn");
const errorTag = new Level("error");

const logger: Logger = {
  isVerbose: verbose,
  verbose: verbose ? (...args: unknown[]) => emit("debug", console.info, debugTag, args) : () => {},
  info: (...args: unknown[]) => emit("info", console.info, infoTag, args),
  warn: (...args: unknown[]) => emit("warn", console.warn, warnTag, args),
  error: (...args: unknown[]) => emit("error", console.error, errorTag, args),
  tag: {
    db: chalk.dim("[gene:db]"),
    flow: chalk.yellowBright("[gene:flow]"),
    invoke: chalk.gray("[gene:invoke]"),
    review: chalk.gray("[gene:review]"),
    reset: chalk.gray("[gene:reset]"),
    log: chalk.gray("[gene:log]"),
    lock: chalk.gray("[gene:lock]"),
    fetch: chalk.gray("[gene:fetch]"),
    ignore: chalk.gray("[gene:ignore]"),
    tracker: chalk.blueBright("[gene:tracker]"),
    forge: chalk.greenBright("[gene:forge]"),
    config: chalk.gray("[gene:config]"),
    clone: chalk.gray("[gene:clone]"),
    attachments: chalk.gray("[gene:attachments]"),
    trello: chalk.blueBright("[gene:trello]"),
    linear: chalk.blueBright("[gene:linear]"),
    update: chalk.cyanBright("[gene:update]"),
    export: chalk.cyanBright("[gene:export]"),
  }
};

export default logger;
