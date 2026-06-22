/**
 * Thin async wrappers around child_process.spawn. Every external integration in
 * this project (linear, glab, gh, git, claude) shells out, so the capture /
 * throw / stream patterns live here once.
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

/**
 * Run a command, delivering its output to `onLine` one line at a time instead of
 * inheriting the terminal. Unlike a raw `stdio: "inherit"`, this NEVER writes to
 * the real stdout/stderr — so it is safe under the TUI, whose log sink owns the
 * alt-screen (a stray write there corrupts the dashboard). Callers route `onLine`
 * to the logger, so the output lands in the log pane under the dashboard and on
 * the console when headless — exactly like every other log line.
 *
 * Because we pipe rather than inherit, the child sees a non-TTY and tools like
 * git drop their in-place "Receiving objects: …%" progress meter on their own;
 * any line that still arrives with `\r` redraw frames is collapsed to its final
 * frame so the log shows the result, not every intermediate tick.
 *
 * No timeout by default (0): this is for deliberately long-running ops like a
 * fresh `git clone`. Pass `opts.timeout` to bound it.
 */
export const runStreaming = (
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
  opts: RunOptions = {}
): Promise<number> =>
  new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timeoutMs = opts.timeout ?? 0;
    const watchdog =
      timeoutMs > 0
        ? setTimeout(() => {
            proc.kill("SIGKILL");
            reject(new Error(`\`${cmd} ${args.join(" ")}\` timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
    watchdog?.unref();

    // Buffer each pipe and flush on newline. Within a logical line, keep only the
    // text after the last `\r` (a progress meter's latest frame); drop blank lines.
    const pump = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) {
        return;
      }
      let buf = "";
      const flush = (raw: string): void => {
        const cr = raw.lastIndexOf("\r");
        const line = (cr >= 0 ? raw.slice(cr + 1) : raw).trimEnd();
        if (line) {
          onLine(line);
        }
      };
      stream.on("data", chunk => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          flush(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      stream.on("end", () => flush(buf));
    };
    pump(proc.stdout);
    pump(proc.stderr);

    proc.on("error", err => {
      watchdog && clearTimeout(watchdog);
      reject(err);
    });
    proc.on("close", code => {
      watchdog && clearTimeout(watchdog);
      resolve(code ?? -1);
    });
  });
