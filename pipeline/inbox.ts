/**
 * Inbox: a tiny on-disk signal mechanism between the webhook endpoint and the
 * polling daemon. The webhook writes a JSON file per Trello action; the daemon
 * watches the inbox directory and triggers an immediate scan when new files
 * appear (instead of waiting for the next poll interval).
 *
 * Inbox files live at `.ai-pipeline/inbox/<actionId>.json` (gitignored). They
 * are consumed and deleted by the daemon on each scan.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from "fs";
import path from "path";

const INBOX_DIR = path.join(process.cwd(), ".ai-pipeline", "inbox");

export type InboxEntry = {
  actionId: string;
  cardId: string;
  actionType: string;
  receivedAt: number;
};

export const inboxDir = (): string => INBOX_DIR;

export const writeInbox = (entry: InboxEntry): void => {
  mkdirSync(INBOX_DIR, { recursive: true });
  const file = path.join(INBOX_DIR, `${entry.actionId}.json`);
  writeFileSync(file, JSON.stringify(entry, null, 2), { flag: "w" });
};

export const drainInbox = (): InboxEntry[] => {
  if (!existsSync(INBOX_DIR)) {
    return [];
  }
  const entries: InboxEntry[] = [];
  for (const name of readdirSync(INBOX_DIR)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const file = path.join(INBOX_DIR, name);
    try {
      const raw = readFileSync(file, "utf-8");
      entries.push(JSON.parse(raw) as InboxEntry);
      unlinkSync(file);
    } catch {
      /* skip malformed entries */
    }
  }
  return entries;
};
