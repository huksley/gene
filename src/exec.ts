/**
 * Thin async wrappers around child_process.spawn. Every external integration in
 * this project (linear, glab, gh, git, claude) shells out, so the capture /
 * throw / inherit patterns live here once.
 */

import { spawn } from "node:child_process";

export type RunResult = { code: number; stdout: string; stderr: string };

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin then closed. Use for passing large bodies safely. */
  input?: string;
};

/** Run a command, capturing stdout/stderr. Never rejects on non-zero exit. */
export const run = (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", chunk => (stdout += chunk.toString()));
    proc.stderr?.on("data", chunk => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
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
