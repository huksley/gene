import { test } from "node:test";
import assert from "node:assert/strict";
import type { Issue } from "../tracker/index.ts";
import type { TriggerStore, TriggerRow, CompiledFields, CheckUpdate } from "./store.ts";
import type { CompileResult } from "./compile.ts";
import type { CheckOutcome } from "./sandbox.ts";
import { createTriggerScanner, type TriggerDeps } from "./index.ts";

const program = (identifier: string, trigger: string, stateName = "Todo"): Issue =>
  ({
    id: `id-${identifier}`,
    identifier,
    title: identifier,
    description: `## Trigger\n${trigger}\n\n## Workflow\nx\n\n## Acceptance criteria\ny`,
    stateName
  }) as unknown as Issue;

const memoryStore = (): TriggerStore & { rows: Map<string, TriggerRow> } => {
  const rows = new Map<string, TriggerRow>();
  return {
    rows,
    read: async (_t, id) => rows.get(id) ?? null,
    saveCompiled: async (f: CompiledFields, now: Date) => {
      rows.set(f.identifier, { ...f, compiledAt: now, lastCheckAt: now, nextCheckAt: now, usedIo: false, errorStreak: 0, errorCommented: false, state: null });
    },
    recordCheck: async (_t, id, u: CheckUpdate) => {
      const r = rows.get(id)!;
      rows.set(id, {
        ...r,
        lastCheckAt: u.lastCheckAt,
        nextCheckAt: u.nextCheckAt,
        lastOutcome: u.lastOutcome,
        lastReason: u.lastReason,
        usedIo: u.usedIo ?? r.usedIo,
        errorStreak: u.errorStreak ?? r.errorStreak,
        errorCommented: u.errorCommented ?? r.errorCommented,
        state: u.state !== undefined ? u.state : r.state
      });
    },
    remove: async (_t, id) => void rows.delete(id)
  };
};

const okCompile = (summary = "always"): CompileResult => ({
  kind: "ok",
  trigger: { summary, intervalSec: 60, code: "c" },
  trial: { fire: false, problems: [] }
});
const fired = (reason?: string): CheckOutcome => ({ ok: true, fire: true, reason, state: null, logs: [], usedIo: false });
const quiet = (): CheckOutcome => ({ ok: true, fire: false, state: null, logs: [], usedIo: true });

const harness = (over: Partial<TriggerDeps> = {}) => {
  let clock = new Date("2026-10-07T09:00:00Z");
  const fires: [string, string | undefined][] = [];
  const comments: string[] = [];
  const events: [string, string][] = [];
  const store = memoryStore();
  const deps: TriggerDeps = {
    trackerName: "linear",
    store,
    now: () => clock,
    isResting: p => p.stateName === "Todo",
    lastFiredAt: async () => undefined,
    fire: (p, reason) => void fires.push([p.identifier, reason]),
    record: async (_p, event, detail) => void events.push([event, detail]),
    comment: async (_p, body) => void comments.push(body),
    compile: async () => okCompile(),
    check: async () => ({ outcome: fired("because"), problems: [] }),
    publish: () => {},
    cfg: { dryRun: false, cooldownMs: 30 * 60_000, pollMs: 60_000, ioFloorMs: 5 * 60_000 },
    ...over
  };
  const scanner = createTriggerScanner(deps);
  return { scanner, store, fires, comments, events, tick: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
};

test("new prose compiles in the background, then a due check fires once", async () => {
  const h = harness();
  const p = program("PRG-1", "every hour");
  await h.scanner.scan([p]);
  assert.deepEqual(h.fires, []);
  await h.scanner.idle();
  assert.deepEqual(h.events.map(e => e[0]), ["trigger-compiled"]);
  await h.scanner.scan([p]);
  assert.deepEqual(h.fires, [["PRG-1", "because"]]);
  await h.scanner.scan([p]); // not due yet (next = now + 60s)
  assert.equal(h.fires.length, 1);
});

test("trigger-compiled reports the trial verdict and problems", async () => {
  const h = harness({
    compile: async () => ({ ...okCompile("Hourly"), trial: { fire: true, reason: "!87", problems: ["Error: not logged in"] } }) as CompileResult
  });
  await h.scanner.scan([program("PRG-1b", "every hour")]);
  await h.scanner.idle();
  assert.equal(h.events[0]![1], "Hourly — would fire now: yes (!87) ⚠ Error: not logged in");
});

test("busy and cooldown skip the check without running it", async () => {
  let checks = 0;
  const h = harness({ check: async () => (checks++, { outcome: fired(), problems: [] }) });
  await h.scanner.scan([program("PRG-2", "every hour")]);
  await h.scanner.idle();
  await h.scanner.scan([program("PRG-2", "every hour", "In Progress")]);
  assert.equal(checks, 0);
  assert.equal(h.store.rows.get("PRG-2")?.lastOutcome, "skipped:busy");

  const h2 = harness({ lastFiredAt: async () => new Date("2026-10-07T08:50:00Z") });
  await h2.scanner.scan([program("PRG-3", "every hour")]);
  await h2.scanner.idle();
  await h2.scanner.scan([program("PRG-3", "every hour")]);
  assert.deepEqual(h2.fires, []);
  assert.equal(h2.store.rows.get("PRG-3")?.lastOutcome, "skipped:cooldown");
});

test("uncompilable posts one comment per prose hash", async () => {
  const h = harness({ compile: async () => ({ kind: "uncompilable", reason: "no schedule" }) });
  const p = program("PRG-4", "vibes");
  await h.scanner.scan([p]);
  await h.scanner.idle();
  await h.scanner.scan([p]);
  await h.scanner.idle();
  assert.equal(h.comments.length, 1);
  assert.match(h.comments[0]!, /Couldn't compile the trigger: no schedule/);
});

test("three consecutive check errors post one comment; success resets", async () => {
  let fail = true;
  const h = harness({
    check: async () => ({
      outcome: fail ? { ok: false, error: "boom", thrown: true, logs: [], usedIo: false } : { ok: true, fire: false, state: null, logs: [], usedIo: false },
      problems: []
    })
  });
  const p = program("PRG-5", "every hour");
  await h.scanner.scan([p]);
  await h.scanner.idle();
  for (let i = 0; i < 5; i++) {
    await h.scanner.scan([p]);
    h.tick(2 * 60 * 60_000);
  }
  assert.equal(h.comments.length, 1);
  assert.match(h.comments[0]!, /Trigger check failing: boom/);
  fail = false;
  await h.scanner.scan([p]);
  assert.equal(h.store.rows.get("PRG-5")?.errorStreak, 0);
});

test("no-fire with exec problems counts as an error; three in a row comment once", async () => {
  const h = harness({ check: async () => ({ outcome: quiet(), problems: ["argocd app: exit 20: not logged in"] }) });
  const p = program("PRG-5b", "when argo is out of sync");
  await h.scanner.scan([p]);
  await h.scanner.idle();
  for (let i = 0; i < 4; i++) {
    await h.scanner.scan([p]);
    h.tick(2 * 60 * 60_000);
  }
  assert.equal(h.store.rows.get("PRG-5b")?.lastOutcome, "error");
  assert.equal(h.comments.length, 1);
  assert.match(h.comments[0]!, /exec problems: argocd app: exit 20: not logged in/);
});

test("fire with exec problems still fires", async () => {
  const h = harness({ check: async () => ({ outcome: fired("down"), problems: ["curl: exit 22: 503"] }) });
  const p = program("PRG-5c", "when health fails");
  await h.scanner.scan([p]);
  await h.scanner.idle();
  await h.scanner.scan([p]);
  assert.deepEqual(h.fires, [["PRG-5c", "down"]]);
});

test("prose changed while compiling: stale result discarded", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const h = harness({
    compile: async prose => {
      if (prose === "every hour") await gate;
      return okCompile(prose);
    }
  });
  await h.scanner.scan([program("PRG-6", "every hour")]);
  await h.scanner.scan([program("PRG-6", "every day")]);
  release();
  await h.scanner.idle();
  await h.scanner.scan([program("PRG-6", "every day")]);
  await h.scanner.idle();
  assert.equal(h.store.rows.get("PRG-6")?.summary, "every day");
});

test("manual removes the trigger row", async () => {
  const h = harness();
  await h.scanner.scan([program("PRG-7", "every hour")]);
  await h.scanner.idle();
  await h.scanner.scan([program("PRG-7", "manual")]);
  assert.equal(h.store.rows.has("PRG-7"), false);
});

test("dry run logs but does not fire or comment", async () => {
  const h = harness({ cfg: { dryRun: true, cooldownMs: 0, pollMs: 60_000, ioFloorMs: 300_000 } });
  await h.scanner.scan([program("PRG-8", "every hour")]);
  await h.scanner.idle();
  await h.scanner.scan([program("PRG-8", "every hour")]);
  assert.deepEqual(h.fires, []);
  assert.ok(h.events.some(e => e[0] === "trigger-fired"));
});

test("a store failure for one program does not stop the others", async () => {
  const h = harness();
  const read = h.store.read;
  h.store.read = async (t, id) => (id === "BAD" ? Promise.reject(new Error("db down")) : read(t, id));
  await h.scanner.scan([program("BAD", "every hour"), program("PRG-9", "every hour")]);
  await h.scanner.idle();
  await h.scanner.scan([program("BAD", "every hour"), program("PRG-9", "every hour")]);
  assert.deepEqual(h.fires, [["PRG-9", "because"]]);
});
