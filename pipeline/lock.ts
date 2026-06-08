/**
 * Card-keyed file lock to prevent two concurrent agent runs against the same
 * Trello card. The lock file contains the current process PID and an acquired
 * timestamp; stale locks (dead PID or too old) are auto-reclaimed.
 *
 * Lock files live under `.ai-pipeline/locks/<cardId>.lock` (gitignored).
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { mkdirSync } from "fs";
import path from "path";
import logger from "@/lib/logger";

const LOCK_DIR = path.join(process.cwd(), ".ai-pipeline", "locks");
const MAX_LOCK_AGE_MS = 15 * 60 * 1000;

export const lockDir = (): string => LOCK_DIR;

type LockFile = {
  pid: number;
  acquiredAt: number;
};

const lockPath = (cardId: string): string => path.join(LOCK_DIR, `${cardId}.lock`);

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

export type Lock = { cardId: string; path: string };

export const acquireLock = (cardId: string): Lock | null => {
  mkdirSync(LOCK_DIR, { recursive: true });
  const file = lockPath(cardId);

  if (existsSync(file)) {
    const existing = readLock(file);
    const stale =
      existing === null ||
      !isAlive(existing.pid) ||
      Date.now() - existing.acquiredAt > MAX_LOCK_AGE_MS;
    if (!stale) {
      logger.info(
        `[ai-pipeline] [${cardId}] lock held by pid ${existing?.pid} since ${new Date(
          existing?.acquiredAt ?? 0
        ).toISOString()} — skipping`
      );
      return null;
    }
    logger.warn(
      `[ai-pipeline] [${cardId}] reclaiming stale lock (pid ${existing?.pid ?? "?"})`
    );
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
  }

  const payload: LockFile = { pid: process.pid, acquiredAt: Date.now() };
  writeFileSync(file, JSON.stringify(payload, null, 2), { flag: "wx" });
  return { cardId, path: file };
};

export const releaseLock = (lock: Lock): void => {
  try {
    unlinkSync(lock.path);
  } catch {
    /* ignore — already gone */
  }
};

export const withLock = async <T>(
  cardId: string,
  fn: () => Promise<T>
): Promise<T | "skipped"> => {
  const lock = acquireLock(cardId);
  if (lock === null) {
    return "skipped";
  }
  try {
    return await fn();
  } finally {
    releaseLock(lock);
  }
};

/**
 * Returns the cardIds of locks owned by the current process.
 * Used during graceful shutdown to clean up `ai:working` labels.
 */
export const listOwnedLocks = (): string[] => {
  if (!existsSync(LOCK_DIR)) {
    return [];
  }
  const cardIds: string[] = [];
  for (const file of readdirSync(LOCK_DIR)) {
    if (!file.endsWith(".lock")) {
      continue;
    }
    const lock = readLock(path.join(LOCK_DIR, file));
    if (lock?.pid === process.pid) {
      cardIds.push(file.slice(0, -".lock".length));
    }
  }
  return cardIds;
};
