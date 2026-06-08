/**
 * `fetch` with a per-attempt timeout and bounded retries — for the handful of
 * direct network calls the orchestrator makes itself (currently only the Linear
 * attachment downloads in `attachments.ts`). Transient failures (dropped sockets,
 * timeouts, 429/5xx) are retried with exponential backoff; other 4xx responses
 * are returned as-is so the caller decides what a 401/404 means.
 *
 * This does NOT cover the spawned `claude -p` agent's own calls to the Anthropic
 * API — those happen inside the agent process, out of our reach. That path has its
 * own spawn-level retry in `invoke.ts`.
 */

import logger from "./logger.ts";

export const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BACKOFF_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export type FetchRetryOptions = RequestInit & {
  /** Per-attempt timeout in ms, enforced via AbortSignal.timeout (default 30s). */
  timeout?: number;
  /** Number of retries after the first attempt (total tries = retries + 1). */
  retries?: number;
  /** Base backoff in ms; doubles each retry (default 500ms → 1s → 2s …). */
  backoffMs?: number;
};

/** 429 + 5xx are transient and worth retrying; other statuses are returned as-is. */
const isRetriableStatus = (status: number): boolean => status === 429 || status >= 500;

export const fetchRetryTimeout = async (
  url: string,
  options: FetchRetryOptions = {}
): Promise<Response> => {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_MAX_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
    ...init
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      if (isRetriableStatus(res.status) && attempt < retries) {
        logger.warn(`[gene] fetch ${url} → HTTP ${res.status}; retrying (${attempt + 1}/${retries})`);
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(`[gene] fetch ${url} failed (${reason}); retrying (${attempt + 1}/${retries})`);
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`fetch ${url} failed after ${retries + 1} tries`);
};
