/**
 * Per-issue file lock preventing two concurrent agent runs against the same
 * Linear issue. The lock file holds the owning process PID and an acquired
 * timestamp; stale locks (dead PID or too old) are auto-reclaimed.
 *
 * Lock files live under `.gene/locks/<IDENTIFIER>.lock` (gitignored), keyed by
 * the Linear issue identifier (e.g. `CLOUD-1094`). While a lock is held, Gene AI
 * owns the issue — the `Gene` label stays put regardless.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import logger from "./logger.ts";
import { LOCK_DIR } from "./config.ts";

const MAX_LOCK_AGE_MS = 15 * 60 * 1000;

export const lockDir = (): string => LOCK_DIR;

type LockFile = {
  pid: number;
  acquiredAt: number;
};

const lockPath = (issueId: string): string => path.join(LOCK_DIR, `${issueId}.lock`);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readLock = (file: string): LockFile | null => {
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as LockFile;
    if (typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export type Lock = { issueId: string; path: string };

export const acquireLock = (issueId: string): Lock | null => {
  mkdirSync(LOCK_DIR, { recursive: true });
  const file = lockPath(issueId);

  if (existsSync(file)) {
    const existing = readLock(file);
    const stale =
      existing === null ||
      !isAlive(existing.pid) ||
      Date.now() - existing.acquiredAt > MAX_LOCK_AGE_MS;
    if (!stale) {
      logger.info(
        `[gene] [${issueId}] lock held by pid ${existing?.pid} since ${new Date(
          existing?.acquiredAt ?? 0
        ).toISOString()} — skipping`
      );
      return null;
    }
    logger.warn(`[gene] [${issueId}] reclaiming stale lock (pid ${existing?.pid ?? "?"})`);
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
  }

  const payload: LockFile = { pid: process.pid, acquiredAt: Date.now() };
  writeFileSync(file, JSON.stringify(payload, null, 2), { flag: "wx" });
  return { issueId, path: file };
};

export const releaseLock = (lock: Lock): void => {
  try {
    unlinkSync(lock.path);
  } catch {
    /* ignore — already gone */
  }
};

export const withLock = async <T>(
  issueId: string,
  fn: () => Promise<T>
): Promise<T | "skipped"> => {
  const lock = acquireLock(issueId);
  if (lock === null) {
    return "skipped";
  }
  try {
    return await fn();
  } finally {
    releaseLock(lock);
  }
};

/** Issue identifiers whose locks are owned by the current process (for shutdown cleanup). */
export const listOwnedLocks = (): string[] => {
  if (!existsSync(LOCK_DIR)) {
    return [];
  }
  const issueIds: string[] = [];
  for (const file of readdirSync(LOCK_DIR)) {
    if (!file.endsWith(".lock")) {
      continue;
    }
    const lock = readLock(path.join(LOCK_DIR, file));
    if (lock?.pid === process.pid) {
      issueIds.push(file.slice(0, -".lock".length));
    }
  }
  return issueIds;
};
