/* eslint-disable no-console */
import chalk from "chalk";

/**
 * Minimal server-side logger (Node-only — no browser branch). Each line is
 * prefixed with an ISO timestamp and the level so the daemon's long-running
 * output stays greppable.
 *
 * Usage:
 *   import logger from "./logger.ts";
 *   logger.info("...");
 *   if (logger.isVerbose) logger.verbose("...");
 */

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
  };
  verbose: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Lazily stringifies to a timestamped prefix at the moment the line is logged. */
class Level {
  readonly _level: "DEBUG" | "INFO" | "WARN" | "ERROR";

  constructor(level: "DEBUG" | "INFO" | "WARN" | "ERROR") {
    this._level = level;
  }

  toString(): string {
    return `${chalk.gray(new Date().toLocaleTimeString())} ${this._level === "DEBUG" ? chalk.dim(this._level) : this._level === "INFO" ? chalk.white(this._level) : this._level === "WARN" ? chalk.yellow(this._level) : chalk.red(this._level)}`;
  }

  [Symbol.toPrimitive](hint: string): string | undefined {
    return hint === "string" ? this.toString() : undefined;
  }
}

const verbose = process.env.GENE_LOG_VERBOSE === "1" || process.env.LINEAR_DEBUG === "1";

const logger: Logger = {
  isVerbose: verbose,
  verbose: verbose
    ? console.info.bind(console, "%s", new Level("DEBUG"))
    : () => { },
  info: console.info.bind(console, "%s", new Level("INFO")),
  warn: console.warn.bind(console, "%s", new Level("WARN")),
  error: console.error.bind(console, "%s", new Level("ERROR")),
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
  }
};

export default logger;
