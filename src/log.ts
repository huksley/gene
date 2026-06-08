/**
 * Show an issue's activity log — the per-issue record of what the daemon did for
 * it, persisted in the embedded state store (db.ts) and keyed by (tracker system,
 * issue/card id): dispatches, the agent's start/finish + final summary, review
 * re-dispatches, draft pickups, and resets.
 *
 * Usage:
 *   npm run log -- <system>:<ISSUE-ID>     # e.g. linear:CLOUD-1094, trello:aB3xYz9
 *   npm run log -- <ISSUE-ID>              # system defaults to GENE_TRACKER
 *
 * Read-only: it touches only the local store, never the tracker or the forge.
 */

import logger from "./logger.ts";
import { env } from "./config.ts";
import { closeDb, readIssueLog } from "./db.ts";

const USAGE = "[gene:log] Usage: npm run log -- <system>:<ISSUE-ID>   (e.g. linear:CLOUD-1094)";

const print = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

const main = async (): Promise<void> => {
  const arg = process.argv[2];
  if (!arg || arg.startsWith("--")) {
    logger.error(USAGE);
    process.exit(1);
  }

  // Accept "system:identifier" (linear:CLOUD-1094) or a bare identifier — in which
  // case the system falls back to the configured GENE_TRACKER.
  const sep = arg.indexOf(":");
  const system = sep > 0 ? arg.slice(0, sep).toLowerCase() : env.TRACKER;
  const identifier = (sep > 0 ? arg.slice(sep + 1) : arg).trim();
  if (!identifier) {
    logger.error(USAGE);
    process.exit(1);
  }

  const rows = await readIssueLog(system, identifier);
  if (rows.length === 0) {
    print(`${system}:${identifier} — no activity logged yet`);
    return;
  }

  print(`${system}:${identifier} — ${rows.length} event(s)`);
  print("");
  const eventWidth = Math.max(...rows.map(r => r.event.length));
  for (const row of rows) {
    // Keep one event per line — collapse any newlines a stored detail may carry.
    const detail = row.detail.replace(/\s*\n\s*/g, " ");
    print(`  ${row.createdAt}  ${row.event.padEnd(eventWidth)}  ${detail}`);
  }
};

main()
  .catch(error => {
    logger.error("[gene:log] fatal:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeDb);
