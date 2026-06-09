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

  const sep = arg && arg !== "--" ? arg.indexOf(":") : undefined;
  let system = sep !== undefined && sep > 0 ? arg.slice(0, sep).toLowerCase() : undefined;
  let identifier = sep !== undefined ? (sep > 0 ? arg.slice(sep + 1) : arg).trim() : undefined;
  const rows = await readIssueLog(system, identifier);
  if (rows.length === 0) {
    print(`No activity logged yet`);
    return;
  }

  print(`${system ? `${system}:${identifier} — ` : ""}${rows.length} event(s)`);
  print("");
  const eventWidth = Math.max(...rows.map(r => r.event.length));
  for (const row of rows) {
    // Keep one event per line — collapse any newlines a stored detail may carry.
    const detail = row.detail.replace(/\s*\n\s*/g, " ");
    print(`  ${row.createdAt} ${row.tracker}:${row.identifier} ${row.event.padEnd(eventWidth)}  ${detail}`);
  }
};

main()
  .catch(error => {
    logger.error("[gene:log] fatal:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeDb);
