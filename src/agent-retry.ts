/**
 * Pure agent-run retry classification, kept dependency-free so it can be unit
 * tested without pulling in the tracker singleton / Postgres that `invoke.ts`
 * transitively imports.
 *
 *  - `matchesTransient` recognises assistant text that signals the model API
 *    connection itself failed at the transport layer (a dropped socket mid-run),
 *    as opposed to a tool error. `claude -p` exits 0 in this case even though the
 *    work didn't finish, so we must detect it from the stream text.
 *  - `matchesAuthFailure` recognises the CLI's own "not logged in" output (an
 *    expired OAuth session, a bad API key). Re-spawning can't fix that — only a
 *    human re-login can — so it is never retried.
 *  - `isRetriable` decides whether a finished run should be spawned again within
 *    the retry budget — covering both non-zero crashes and the deceptive exit-0
 *    "didn't actually finish" cases (silent crash / transient drop).
 */

/** Signatures in assistant text that mean the API transport dropped, not a tool failure. */
export const TRANSIENT_API_PATTERNS: RegExp[] = [
  /api error.*socket connection was closed/i,
  /api error.*connection.*closed/i,
  /api error.*network/i,
  /api error.*timeout/i,
  /econnreset/i,
  /upstream connect error/i,
  /fetch failed/i
];

/** True when `text` contains a known transient-transport signature. */
export const matchesTransient = (text: string): boolean =>
  TRANSIENT_API_PATTERNS.some(pattern => pattern.test(text));

/**
 * Signatures of the `claude` CLI failing to authenticate. Anchored to the start of
 * the text (the CLI emits them as a whole assistant block) or specific enough that
 * ordinary prose about auth code in the target repo won't trip them.
 */
export const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /^\s*failed to authenticate\b/i,
  /^\s*invalid api key\b/i,
  /oauth (session|token) (has )?expired/i,
  /please run \/login\b/i,
  /^\s*api error:\s*401\b/i
];

/** True when `text` is the CLI reporting that it could not authenticate. */
export const matchesAuthFailure = (text: string): boolean =>
  AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(text));

/**
 * Should a finished run be retried (within the AGENT_MAX_RETRIES budget)?
 *
 *  - The turn-limit (`error_max_turns`) is never retried — a re-run burns the
 *    same budget to the same wall.
 *  - An auth failure is never retried — every re-spawn fails the same way until
 *    a human logs in again.
 *  - Any non-zero exit is a crash/transient error → retry.
 *  - Exit 0 normally means "done", EXCEPT when the run didn't truly finish:
 *    a transient API drop was seen mid-stream, or the CLI never emitted its
 *    terminal `result`/`success` event (`resultSubtype !== "success"`).
 */
export const isRetriable = (
  exitCode: number,
  resultSubtype: string | undefined,
  transientFailure: boolean,
  authFailure = false
): boolean => {
  if (resultSubtype === "error_max_turns" || authFailure) {
    return false;
  }
  if (exitCode !== 0) {
    return true;
  }
  return transientFailure || resultSubtype !== "success";
};
