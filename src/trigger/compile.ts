/**
 * Compiles a program's free-form `## Trigger` prose into a `check(gene)` function, once
 * per prose hash. A short tool-less `claude -p` run writes the code; we parse it,
 * trial-run it once against the real host (never firing the program), and retry once
 * with any error or exec problems. Runner and trial host are injected so tests spawn
 * nothing.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import { env } from "../config.ts";
import { runCheck, type CheckHost } from "./sandbox.ts";
import { parseDurationSec } from "./schedule.ts";

export type CompileRunner = (prompt: string) => Promise<string>;
export type CompiledTrigger = { summary: string; intervalSec: number; code: string };
/** What the trial run at compile time saw: would it fire right now, and did its commands complain. */
export type TrialVerdict = { fire: boolean; reason?: string; problems: string[] };
export type TrialHost = CheckHost & { problems: string[] };
export type CompileResult =
  | { kind: "ok"; trigger: CompiledTrigger; trial: TrialVerdict }
  | { kind: "uncompilable"; reason: string }
  | { kind: "invalid"; error: string };

type ParsedReply =
  | { kind: "ok"; trigger: CompiledTrigger }
  | { kind: "uncompilable"; reason: string }
  | { kind: "invalid"; error: string };

const FENCE = "```";

/** Trimmed prose, or null when the section means "no trigger" (missing, empty, manual, none). */
export const normaliseTriggerProse = (section: string): string | null => {
  const text = section.trim();
  if (text === "" || /^(manual|none)$/i.test(text)) return null;
  return text;
};

export const proseHash = (prose: string): string => crypto.createHash("sha256").update(prose.trim()).digest("hex");

export const buildCompilePrompt = (
  prose: string,
  opts: { execAllow: string[]; ioFloorMin: number; previousError?: string }
): string =>
  [
    "You compile a program's trigger, written in plain English, into a small JavaScript function that Gene runs on a schedule to decide whether to start the program.",
    "",
    "# Trigger",
    "",
    prose,
    "",
    "# The function",
    "",
    "Write exactly one `async function check(gene)` that returns `{ fire: boolean, reason?: string }`. It runs in a sandbox with NO other globals (no fetch, process, require, timers). Available API:",
    "",
    "- `gene.cron(expr, { tz? })` → boolean: true if the 5-field cron `expr` had a tick since the previous check. Use it for any time-based schedule.",
    "- `await gene.fetch(url, { method?, headers?, body? })` → `{ status, headers, text, json() }`. http/https only, no credentials are added — use it only for public or unauthenticated endpoints.",
    opts.execAllow.length > 0
      ? `- \`await gene.exec(cmd, args)\` → \`{ code, stdout, stderr }\`. No shell (no pipes, no $()). ONLY commands starting with one of: ${opts.execAllow.map(a => `\`${a}\``).join(", ")}. Prefer these CLIs for anything that needs authentication; they are already logged in. \`glab api\` is read-only (no -X/--method/-f/-F).`
      : "- `gene.exec` is not available (no commands are allowed). Use only `gene.cron` and `gene.fetch`.",
    "- `gene.state`: a JSON object kept between runs (≤ 16 KB) — e.g. to remember what you already reported.",
    "- `gene.now()` → ISO timestamp; `gene.log(msg)` for debugging.",
    "",
    "At most 10 fetch/exec calls per run; 1 s of CPU.",
    "",
    "# Rules",
    "",
    "- Put the specifics in `reason` (which merge requests, which apps, what changed) — it is handed to the program run.",
    '- If the trigger\'s condition needs human-like judgment (e.g. "when anything needs fixing") and cannot be checked cheaply, fall back to a schedule: use the schedule in the text if there is one, else daily at 08:00, and say so in SUMMARY (e.g. "Daily 08:00 — condition needs judgment; the run checks it").',
    "- Only if there is no workable schedule either, answer with a single line `UNCOMPILABLE: <why>` and nothing else.",
    `- INTERVAL is how often the check should run: \`1m\` for pure cron checks; for checks that call fetch/exec at least \`${opts.ioFloorMin}m\`, matching the urgency in the text.`,
    "",
    "# Reply format (exactly this, nothing else)",
    "",
    'SUMMARY: <one line plain English, e.g. "Weekdays at 09:00 Europe/Berlin">',
    "INTERVAL: <e.g. 1m | 15m | 1h>",
    `${FENCE}js`,
    "async function check(gene) { ... }",
    FENCE,
    ...(opts.previousError
      ? ["", "# Your previous answer was rejected", "", opts.previousError, "", "Fix it and answer again in the same format."]
      : [])
  ].join("\n");

const CODE_BLOCK = new RegExp(`${FENCE}(?:js|javascript)?\\s*\\n([\\s\\S]*?)${FENCE}`);

export const parseCompileReply = (text: string): ParsedReply => {
  const unc = /^\s*UNCOMPILABLE:\s*(.+)$/m.exec(text);
  if (unc && !text.includes(FENCE)) return { kind: "uncompilable", reason: unc[1]!.trim() };
  const summary = /^\s*SUMMARY:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const intervalText = /^\s*INTERVAL:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const code = CODE_BLOCK.exec(text)?.[1]?.trim();
  if (!summary) return { kind: "invalid", error: "reply has no SUMMARY line" };
  if (!intervalText) return { kind: "invalid", error: "reply has no INTERVAL line" };
  const intervalSec = parseDurationSec(intervalText);
  if (intervalSec === undefined) return { kind: "invalid", error: `INTERVAL "${intervalText}" is not like 1m / 15m / 1h` };
  if (!code) return { kind: "invalid", error: "reply has no js code block" };
  return { kind: "ok", trigger: { summary, intervalSec, code } };
};

/**
 * Run freshly compiled code once against `host` (real fetch/exec at compile time). Any
 * failure — syntax, missing check, a throw, a limit, a bad shape — is an `error`; exec
 * problems the host collected come back alongside the verdict.
 */
export const trialRun = async (
  code: string,
  host: TrialHost
): Promise<{ error?: string; fire?: boolean; reason?: string; problems: string[] }> => {
  const out = await runCheck(code, host, null);
  if (!out.ok) return { error: out.error, problems: host.problems };
  return { fire: out.fire, reason: out.reason, problems: host.problems };
};

export const compileTrigger = async (
  prose: string,
  runner: CompileRunner,
  opts: { execAllow: string[]; ioFloorMin: number; trialHost: () => TrialHost }
): Promise<CompileResult> => {
  let previousError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await runner(buildCompilePrompt(prose, { execAllow: opts.execAllow, ioFloorMin: opts.ioFloorMin, previousError }));
    } catch (error) {
      return { kind: "invalid", error: `compile run failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const parsed = parseCompileReply(text);
    if (parsed.kind === "uncompilable") return parsed;
    if (parsed.kind === "invalid") {
      previousError = parsed.error;
      continue;
    }
    const trial = await trialRun(parsed.trigger.code, opts.trialHost());
    if (trial.error !== undefined) {
      previousError = `The check failed when run: ${trial.error}`;
      continue;
    }
    // Commands that complained get one chance to be fixed (wrong flag, wrong endpoint).
    // If they still complain on the retry the code itself ran, so accept it: the cause is
    // likely the environment (a CLI not logged in), which the runtime error flow surfaces.
    if (trial.problems.length > 0 && attempt === 0) {
      previousError = `The check ran, but its commands reported problems: ${trial.problems.join("; ")}`;
      continue;
    }
    return { ...parsed, trial: { fire: trial.fire ?? false, reason: trial.reason, problems: trial.problems } };
  }
  return { kind: "invalid", error: previousError ?? "compile failed" };
};

/** The real runner: a tool-less, MCP-less, non-persisted `claude -p` with plain-text output. */
export const claudeRunner =
  (model: string): CompileRunner =>
  prompt =>
    new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      if (!env.CLAUDE_API_BILLING) delete childEnv.ANTHROPIC_API_KEY;
      execFile(
        env.CLAUDE_BIN,
        ["-p", prompt, "--model", model, "--output-format", "text", "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
        { cwd: os.tmpdir(), env: childEnv, timeout: 120_000, maxBuffer: 1024 * 1024, encoding: "utf-8" },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}${stderr ? `: ${String(stderr).slice(0, 300)}` : ""}`));
          else resolve(String(stdout));
        }
      );
    });
