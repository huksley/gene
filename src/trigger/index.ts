/**
 * The trigger scanner: per program, keep its compiled check in step with the `## Trigger`
 * prose (background compile on change), then run due checks behind the busy/cooldown
 * gates and fire through the injected `fire` hook. Daemon specifics (tracker, store,
 * monitor, the fire queue) arrive as {@link TriggerDeps} so this is testable in isolation.
 */
import logger from "../logger.ts";
import type { Issue } from "../tracker/index.ts";
import { extractProgramSections } from "../programs.ts";
import { normaliseTriggerProse, proseHash, type CompileResult } from "./compile.ts";
import type { CheckOutcome } from "./sandbox.ts";
import { decideTrigger, effectiveIntervalMs } from "./schedule.ts";
import type { TriggerRow, TriggerStore } from "./store.ts";

const ERROR_COMMENT_STREAK = 3;
/** Wait before retrying a compile whose run failed (claude timed out, rate-limited, logged out). */
const COMPILE_RETRY_MS = 10 * 60_000;
/** Due checks run in parallel up to this many, so one hung CLI can't hold up every program. */
const CHECK_CONCURRENCY = 4;

export type TriggerView = {
  status: "ok" | "uncompilable" | "invalid" | "compiling";
  summary?: string;
  code?: string;
  error?: string;
  nextCheckAt?: number;
  lastCheckAt?: number;
  lastOutcome?: string;
  lastReason?: string;
  intervalSec?: number;
};

export type TriggerDeps = {
  trackerName: string;
  store: TriggerStore;
  now: () => Date;
  isResting: (program: Issue) => boolean;
  lastFiredAt: (program: Issue) => Promise<Date | undefined>;
  fire: (program: Issue, reason: string | undefined) => void;
  record: (program: Issue, event: string, detail: string, data?: unknown) => Promise<void>;
  comment: (program: Issue, body: string) => Promise<void>;
  compile: (prose: string) => Promise<CompileResult>;
  /** Run a check; `problems` are exec calls that looked failed (host.ts execProblem). */
  check: (code: string, state: unknown, windowStart: Date, now: Date) => Promise<{ outcome: CheckOutcome; problems: string[] }>;
  publish: (identifier: string, view: TriggerView | undefined) => void;
  cfg: { dryRun: boolean; cooldownMs: number; pollMs: number; ioFloorMs: number };
};

export type TriggerScanner = { scan(programs: Issue[]): Promise<void>; idle(): Promise<void> };

const viewOf = (row: TriggerRow): TriggerView => ({
  status: row.status,
  summary: row.summary,
  code: row.code,
  error: row.status === "ok" ? (row.lastOutcome === "error" ? row.lastReason : undefined) : row.compileError,
  nextCheckAt: row.nextCheckAt?.getTime(),
  lastCheckAt: row.lastCheckAt?.getTime(),
  lastOutcome: row.lastOutcome,
  lastReason: row.lastReason,
  intervalSec: row.intervalSec
});

export const createTriggerScanner = (deps: TriggerDeps): TriggerScanner => {
  const latestHash = new Map<string, string>();
  const compiling = new Set<string>();
  /** `${identifier}:${hash}` → epoch ms before which an unavailable compile isn't retried. */
  const retryAfter = new Map<string, number>();
  let queue: Promise<void> = Promise.resolve();

  const interval = (row: TriggerRow, usedIo: boolean, errorStreak: number): number =>
    effectiveIntervalMs({ intervalSec: row.intervalSec, usedIo, errorStreak, pollMs: deps.cfg.pollMs, ioFloorMs: deps.cfg.ioFloorMs });

  const enqueueCompile = (program: Issue, prose: string, hash: string): void => {
    const key = `${program.identifier}:${hash}`;
    if (compiling.has(key) || (retryAfter.get(key) ?? 0) > deps.now().getTime()) return;
    compiling.add(key);
    queue = queue.then(async () => {
      try {
        const result = await deps.compile(prose);
        if (latestHash.get(program.identifier) !== hash) return; // prose moved on — drop the stale result
        if (result.kind === "unavailable") {
          // Not the prose's fault: cache nothing, comment nothing, try again after a pause.
          retryAfter.set(key, deps.now().getTime() + COMPILE_RETRY_MS);
          logger.warn(`${logger.tag.trigger} [${program.identifier}] ${result.error} — retrying in ${COMPILE_RETRY_MS / 60_000}m`);
          return;
        }
        retryAfter.delete(key);
        const base = { tracker: deps.trackerName, identifier: program.identifier, proseHash: hash };
        if (result.kind === "ok") {
          const { summary, code, intervalSec } = result.trigger;
          const { trial } = result;
          await deps.store.saveCompiled({ ...base, status: "ok", summary, code, intervalSec }, deps.now());
          const verdict =
            `would fire now: ${trial.fire ? "yes" : "no"}${trial.reason ? ` (${trial.reason})` : ""}` +
            (trial.problems.length > 0 ? ` ⚠ ${trial.problems.join("; ")}` : "");
          await deps.record(program, "trigger-compiled", `${summary} — ${verdict}`, { code, intervalSec, trial });
          logger.info(`${logger.tag.trigger} [${program.identifier}] compiled: ${summary}`);
        } else {
          const message = result.kind === "uncompilable" ? result.reason : result.error;
          await deps.store.saveCompiled({ ...base, status: result.kind, compileError: message }, deps.now());
          await deps.record(program, `trigger-${result.kind}`, message);
          logger.warn(`${logger.tag.trigger} [${program.identifier}] trigger not compiled: ${message}`);
          if (!deps.cfg.dryRun) {
            await deps.comment(program, `⚠️ Couldn't compile the trigger: ${message} — edit \`## Trigger\` to retry.`);
          }
        }
      } catch (error) {
        logger.warn(`${logger.tag.trigger} [${program.identifier}] compile failed:`, error instanceof Error ? error.message : error);
      } finally {
        compiling.delete(key);
      }
    });
  };

  const scanOne = async (program: Issue): Promise<void> => {
    const id = program.identifier;
    const prose = normaliseTriggerProse(extractProgramSections(program.description ?? "").trigger);
    if (prose === null) {
      latestHash.delete(id);
      if (await deps.store.read(deps.trackerName, id)) await deps.store.remove(deps.trackerName, id);
      deps.publish(id, undefined);
      return;
    }
    const hash = proseHash(prose);
    latestHash.set(id, hash);
    const row = await deps.store.read(deps.trackerName, id);
    if (!row || row.proseHash !== hash) {
      enqueueCompile(program, prose, hash);
      deps.publish(id, { status: "compiling" });
      return;
    }
    if (row.status !== "ok" || !row.code) {
      deps.publish(id, viewOf(row));
      return;
    }

    const now = deps.now();
    const gate = decideTrigger({
      now,
      nextCheckAt: row.nextCheckAt,
      resting: deps.isResting(program),
      lastFiredAt: await deps.lastFiredAt(program),
      cooldownMs: deps.cfg.cooldownMs
    });
    if (gate.kind === "not-due") {
      deps.publish(id, viewOf(row));
      return;
    }
    if (gate.kind === "skip") {
      await deps.store.recordCheck(deps.trackerName, id, {
        lastCheckAt: now,
        nextCheckAt: new Date(now.getTime() + interval(row, row.usedIo, row.errorStreak)),
        lastOutcome: `skipped:${gate.reason}`
      });
    } else {
      const { outcome, problems } = await deps.check(row.code, row.state, row.lastCheckAt ?? row.compiledAt, now);
      // A quiet run whose commands complained (expired login, bad flag) is an error, not
      // "nothing to do" — otherwise a broken check would read as all-clear forever. A run
      // that decided to fire still fires: it saw the output.
      const out: CheckOutcome =
        outcome.ok && !outcome.fire && problems.length > 0
          ? { ok: false, error: `exec problems: ${problems.join("; ")}`, thrown: false, logs: outcome.logs, usedIo: outcome.usedIo }
          : outcome;
      if (out.ok) {
        await deps.store.recordCheck(deps.trackerName, id, {
          lastCheckAt: now,
          nextCheckAt: new Date(now.getTime() + interval(row, out.usedIo, 0)),
          lastOutcome: out.fire ? "fire" : "no-fire",
          lastReason: out.reason,
          usedIo: out.usedIo,
          errorStreak: 0,
          errorCommented: false,
          state: out.state
        });
        if (out.fire) {
          const reason = out.reason ?? "trigger condition met";
          if (deps.cfg.dryRun) {
            logger.info(`${logger.tag.trigger} [${id}] would fire (${reason})`);
            await deps.record(program, "trigger-fired", `(would fire) ${reason}`, { reason, logs: out.logs });
          } else {
            logger.info(`${logger.tag.trigger} [${id}] firing: ${reason}`);
            deps.fire(program, out.reason);
            await deps.record(program, "trigger-fired", reason, { reason, logs: out.logs });
          }
        } else {
          logger.verbose(`${logger.tag.trigger} [${id}] no fire${out.reason ? ` (${out.reason})` : ""}`);
        }
      } else {
        const streak = row.errorStreak + 1;
        let commented = row.errorCommented;
        await deps.record(program, "trigger-error", out.error, { logs: out.logs });
        logger.warn(`${logger.tag.trigger} [${id}] check failed (${streak}×): ${out.error}`);
        if (streak >= ERROR_COMMENT_STREAK && !commented && !deps.cfg.dryRun) {
          await deps.comment(program, `⚠️ Trigger check failing: ${out.error}`);
          commented = true;
        }
        await deps.store.recordCheck(deps.trackerName, id, {
          lastCheckAt: now,
          nextCheckAt: new Date(now.getTime() + interval(row, out.usedIo, streak)),
          lastOutcome: "error",
          lastReason: out.error,
          usedIo: out.usedIo,
          errorStreak: streak,
          errorCommented: commented
        });
      }
    }
    const updated = await deps.store.read(deps.trackerName, id);
    deps.publish(id, updated ? viewOf(updated) : undefined);
  };

  return {
    scan: async programs => {
      const pending = [...programs];
      const worker = async (): Promise<void> => {
        for (let program = pending.shift(); program; program = pending.shift()) {
          try {
            await scanOne(program);
          } catch (error) {
            logger.warn(`${logger.tag.trigger} [${program.identifier}] trigger scan failed:`, error instanceof Error ? error.message : error);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, pending.length) }, worker));
    },
    idle: async () => {
      // Drain: a job may enqueue nothing further, but loop in case scans raced in more.
      let current: Promise<void>;
      do {
        current = queue;
        await current;
      } while (current !== queue);
    }
  };
};
