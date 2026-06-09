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
  error: console.error.bind(console, "%s", new Level("ERROR"))
};

export default logger;
