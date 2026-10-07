/**
 * The real capabilities behind a trigger check's `gene` API: cron windows, HTTP, and
 * allowlisted CLI calls. Everything a check can reach goes through here, so the limits
 * live here too (timeouts, output caps, the exec allowlist, glab api read-only).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import type { CheckHost, ExecResult, FetchInit, FetchResult } from "./sandbox.ts";

const FETCH_TIMEOUT_MS = 10_000;
const EXEC_TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 1024 * 1024;

/** True when `expr` has a scheduled tick in `(windowStart, now]`. Throws on an invalid expression. */
export const cronDue = (expr: string, tz: string | undefined, windowStart: Date, now: Date): boolean => {
  const it = CronExpressionParser.parse(expr, { currentDate: windowStart, ...(tz ? { tz } : {}) });
  return it.next().toDate().getTime() <= now.getTime();
};

const PROBLEM_LINE = /\b(error|exception|fail(ed|ure)?|unauthori[sz]ed|forbidden|denied)\b/i;

/**
 * Whether an exec result looks like the command itself failed — a non-zero exit, or an
 * error-ish line on stderr (an expired CLI login often exits 0 but says so on stderr).
 * stdout is data and never scanned. Returns a one-line description, or undefined.
 */
export const execProblem = (cmd: string, args: string[], r: ExecResult): string | undefined => {
  const lines = r.stderr.split("\n").map(l => l.trim()).filter(Boolean);
  if (r.code !== 0) return `${cmd} ${args[0] ?? ""}: exit ${r.code}: ${lines[0] ?? "(no stderr)"}`;
  return lines.find(l => PROBLEM_LINE.test(l));
};

const GLAB_WRITE_FLAGS = new Set(["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"]);

/** `undefined` when `cmd args` starts with a whole-token allowlist entry; otherwise why not. */
export const execAllowed = (cmd: string, args: string[], allow: string[]): string | undefined => {
  const tokens = [cmd, ...args];
  const ok = allow.some(entry => {
    const want = entry.trim().split(/\s+/).filter(Boolean);
    return want.length > 0 && want.every((t, i) => tokens[i] === t);
  });
  if (!ok) return `exec not allowed: ${tokens.slice(0, 3).join(" ")} (GENE_TRIGGER_EXEC_ALLOW)`;
  if (cmd === "glab" && args[0] === "api") {
    const bad = args.find(a => GLAB_WRITE_FLAGS.has(a) || a.startsWith("-X") || a.startsWith("--method="));
    if (bad) return `glab api is read-only in triggers (rejected ${bad})`;
  }
  return undefined;
};

const readCapped = async (res: Response): Promise<string> => {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_OUTPUT - size;
    chunks.push(value.length > room ? value.subarray(0, room) : value);
    size += Math.min(value.length, room);
    if (size >= MAX_OUTPUT) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
};

export const createHost = (opts: {
  windowStart: Date;
  now: Date;
  execAllow: string[];
  env?: NodeJS.ProcessEnv;
}): CheckHost & { problems: string[] } => {
  const problems: string[] = [];
  return {
    problems,
    cron: (expr, tz) => cronDue(expr, tz, opts.windowStart, opts.now),
    now: () => opts.now,
    fetch: async (url: string, init: FetchInit): Promise<FetchResult> => {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`fetch only supports http/https, got ${parsed.protocol}`);
      }
      const res = await fetch(parsed, {
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return { status: res.status, headers, text: await readCapped(res) };
    },
    exec: (cmd: string, args: string[]): Promise<ExecResult> => {
      const denied = execAllowed(cmd, args, opts.execAllow);
      if (denied) return Promise.reject(new Error(denied));
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gene-trigger-"));
      return new Promise(resolve => {
        execFile(
          cmd,
          args,
          { cwd, env: opts.env ?? process.env, timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: "utf-8" },
          (error, stdout, stderr) => {
            fs.rmSync(cwd, { recursive: true, force: true });
            const code =
              error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
            const result = { code, stdout: String(stdout).slice(0, MAX_OUTPUT), stderr: String(stderr).slice(0, MAX_OUTPUT) };
            const problem = execProblem(cmd, args, result);
            if (problem) problems.push(problem);
            resolve(result);
          }
        );
      });
    }
  };
};
