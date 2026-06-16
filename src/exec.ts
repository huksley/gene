/**
 * Thin async wrappers around child_process.spawn. Every external integration in
 * this project (linear, glab, gh, git, claude) shells out, so the capture /
 * throw / inherit patterns live here once.
 */

import { spawn } from "node:child_process";

export type RunResult = { code: number; stdout: string; stderr: string };

/**
 * Default per-call timeout (ms). Bounds every short-lived CLI shell-out (linear,
 * gh, glab, git) so a hung child can never wedge the single-threaded scan loop —
 * the failure mode where one stalled `linear api` call freezes the whole daemon.
 * Generous enough for a `git fetch` on a sizeable repo; override per-call for the
 * rare slower op. The long-running `claude -p` agent spawn does NOT go through
 * here (it lives in invoke.ts with its own hard-kill watchdog).
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin then closed. Use for passing large bodies safely. */
  input?: string;
  /**
   * Max wall time before the child is killed and the call rejects (default 120s).
   * Pass `0` to disable the timeout for a deliberately long-running command.
   */
  timeout?: number;
};

/** Run a command, capturing stdout/stderr. Never rejects on non-zero exit (but does on timeout). */
export const run = (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    // unref() so the watchdog itself never holds the event loop open at shutdown.
    const watchdog =
      timeoutMs > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            // SIGKILL: a hung CLI may ignore SIGTERM; we need it gone, not asked nicely.
            proc.kill("SIGKILL");
            reject(new Error(`\`${cmd} ${args.join(" ")}\` timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
    watchdog?.unref();

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (watchdog) {
        clearTimeout(watchdog);
      }
      fn();
    };

    proc.stdout?.on("data", chunk => (stdout += chunk.toString()));
    proc.stderr?.on("data", chunk => (stderr += chunk.toString()));
    proc.on("error", err => finish(() => reject(err)));
    proc.on("close", code => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
    if (opts.input !== undefined) {
      proc.stdin?.end(opts.input);
    }
  });

/** Run a command, throwing a descriptive error on non-zero exit. */
export const runOrThrow = async (
  cmd: string,
  args: string[],
  opts: RunOptions = {}
): Promise<RunResult> => {
  const result = await run(cmd, args, opts);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "(no output)";
    throw new Error(`\`${cmd} ${args.join(" ")}\` exited ${result.code}: ${detail}`);
  }
  return result;
};

/** Run a command with inherited stdio (streams straight to the daemon console). */
export const runInherit = (cmd: string, args: string[], opts: RunOptions = {}): Promise<number> =>
  new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: "inherit"
    });
    proc.on("error", reject);
    proc.on("close", code => resolve(code ?? -1));
  });
