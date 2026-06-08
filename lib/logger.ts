/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-empty-function */

export interface MinimalLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface Logger extends MinimalLogger {
  isVerbose: boolean;
  verbose: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** "C" on the browser, "S" on the server — lets you see at a glance where a log line came from. */
const src = typeof window === "undefined" ? "S" : "C";

/** Shows level, source (C/S) and the actual timestamp in the console. */
class Level {
  private level: string;

  constructor(level: string) {
    this.level = level;
  }

  toString() {
    const suffix = this.level === "INFO" ? "" : ` ${this.level}`;
    return `${new Date().toISOString()} [${src}]${suffix}`;
  }

  [Symbol.toPrimitive](hint: string) {
    if (hint === "string") {
      return this.toString();
    }
    return undefined;
  }
}

/**
 * Universal logger based on console. Also supports logger.verbose()
 * and level testing properties, i.e. logger.isVerbose || false
 *
 * Usage:
 * ```
 * import logger from "@/lib/logger"
 * logger.info(...)
 * logger.verbose(...)
 *
 * if (logger.isVerbose) {
 *  logger.verbose(...)
 * }
 * ```
 */
const logger: Logger = {
  isVerbose: process.env.NEXT_PUBLIC_LOG_VERBOSE === "1" ? true : false,
  verbose:
    process.env.NEXT_PUBLIC_LOG_VERBOSE === "1"
      ? console.info.bind(console.info, "%s", new Level("DEBUG"))
      : () => {},
  info: console.info.bind(console.info, "%s", new Level("INFO")),
  warn: console.warn.bind(console.warn, "%s", new Level("WARN")),
  error: console.error.bind(console.error, "%s", new Level("ERROR"))
};

export default logger;
