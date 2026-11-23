/**
 * Live PR / MR status for the change requests sessions opened, through Gene's forge layer
 * (`gh` / `glab`, already authenticated for Gene). Cached and refreshed in the background:
 * a page load never waits on the forge. A merged or closed change request is final and is
 * never looked up again.
 */
import logger from "../../logger.ts";
import { selectForge } from "../../forge/index.ts";
import { parseChangeRequestUrl } from "../../repos.ts";
import type { PrStatus } from "./types.ts";

const OPEN_TTL_MS = 5 * 60_000;
const FAILED_TTL_MS = 15 * 60_000;
const CONCURRENCY = 2;

type Entry = { checkedAt: number; status?: PrStatus; failed?: boolean };
const cache = new Map<string, Entry>();
let refreshing = false;

const isStale = (entry: Entry | undefined, now: number): boolean => {
  if (!entry) return true;
  if (entry.status && (entry.status.state === "merged" || entry.status.state === "closed")) return false;
  return now - entry.checkedAt > (entry.failed ? FAILED_TTL_MS : OPEN_TTL_MS);
};

const lookup = async (url: string): Promise<PrStatus | undefined> => {
  const ref = parseChangeRequestUrl(url);
  if (!ref) return undefined;
  const review = await selectForge(ref.forge).getReviewByIid({ forge: ref.forge, host: ref.host, repoPath: ref.repoPath }, ref.iid);
  if (!review) return undefined;
  return {
    state: review.state,
    isDraft: review.isDraft,
    ci: review.ci.status,
    ...(review.ci.url ? { ciUrl: review.ci.url } : {}),
    checkedAt: new Date().toISOString()
  };
};

/** The cached status of a change request (undefined until first looked up). */
export const prStatus = (url: string): PrStatus | undefined => cache.get(url)?.status;

/** Look up stale change requests in the background, newest-first as given. */
export const refreshPrStatuses = (urls: string[]): void => {
  if (refreshing) return;
  const now = Date.now();
  const queue = [...new Set(urls)].filter(url => parseChangeRequestUrl(url) && isStale(cache.get(url), now));
  if (queue.length === 0) return;
  refreshing = true;
  const worker = async (): Promise<void> => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      try {
        const status = await lookup(url);
        cache.set(url, status ? { checkedAt: Date.now(), status } : { checkedAt: Date.now(), failed: true, status: cache.get(url)?.status });
      } catch (error) {
        logger.verbose(`${logger.tag.web} PR status ${url}:`, error instanceof Error ? error.message : error);
        cache.set(url, { checkedAt: Date.now(), failed: true, status: cache.get(url)?.status });
      }
    }
  };
  void Promise.all(Array.from({ length: CONCURRENCY }, worker)).finally(() => {
    refreshing = false;
  });
};
