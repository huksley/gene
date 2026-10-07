import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheck, DEFAULT_LIMITS, type CheckHost } from "./sandbox.ts";

const host = (over: Partial<CheckHost> = {}): CheckHost => ({
  cron: () => false,
  fetch: async () => ({ status: 200, headers: {}, text: "{\"ok\":true}" }),
  exec: async () => ({ code: 0, stdout: "[]", stderr: "" }),
  now: () => new Date("2026-10-07T09:00:00Z"),
  ...over
});

test("returns fire + reason and persists state", async () => {
  const out = await runCheck(
    `async function check(gene) { gene.state = { n: (gene.state?.n ?? 0) + 1 }; return { fire: true, reason: "go" }; }`,
    host(),
    { n: 41 }
  );
  assert.deepEqual(out, { ok: true, fire: true, reason: "go", state: { n: 42 }, logs: [], usedIo: false });
});

test("cron is synchronous and passes tz", async () => {
  const seen: unknown[] = [];
  const out = await runCheck(
    `async function check(gene) { return { fire: gene.cron("0 9 * * 1-5", { tz: "Europe/Berlin" }) }; }`,
    host({ cron: (e, tz) => (seen.push([e, tz]), true) }),
    null
  );
  assert.equal(out.ok && out.fire, true);
  assert.deepEqual(seen, [["0 9 * * 1-5", "Europe/Berlin"]]);
});

test("fetch and exec round-trip and mark usedIo", async () => {
  const out = await runCheck(
    `async function check(gene) {
       const r = await gene.fetch("https://x/health");
       const e = await gene.exec("glab", ["api", "merge_requests"]);
       return { fire: r.json().ok && JSON.parse(e.stdout).length === 0, reason: String(r.status) };
     }`,
    host(),
    null
  );
  assert.deepEqual(out.ok && [out.fire, out.reason, out.usedIo], [true, "200", true]);
});

test("host rejection surfaces as a thrown error in the check", async () => {
  const out = await runCheck(
    `async function check(gene) { await gene.exec("rm", ["-rf", "/"]); return { fire: true }; }`,
    host({ exec: async () => { throw new Error("exec not allowed: rm"); } }),
    null
  );
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /exec not allowed: rm/);
  assert.equal(!out.ok && out.thrown, true);
});

test("no ambient capabilities", async () => {
  const out = await runCheck(
    `async function check() { return { fire: false, reason: [typeof process, typeof require, typeof setTimeout, typeof fetch].join(",") }; }`,
    host(),
    null
  );
  assert.equal(out.ok && out.reason, "undefined,undefined,undefined,undefined");
});

test("missing check function", async () => {
  const out = await runCheck(`const x = 1;`, host(), null);
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /check is not a function/);
  assert.equal(!out.ok && out.thrown, false);
});

test("syntax error", async () => {
  const out = await runCheck(`async function check( {`, host(), null);
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.thrown, false);
});

test("bad result shape", async () => {
  for (const ret of [`{}`, `{ fire: "yes" }`, `true`, `null`]) {
    const out = await runCheck(`async function check() { return ${ret}; }`, host(), null);
    assert.equal(out.ok, false, ret);
    assert.match(!out.ok ? out.error : "", /must return \{ fire: boolean/);
  }
});

test("reason truncated to 500 chars", async () => {
  const out = await runCheck(`async function check() { return { fire: true, reason: "x".repeat(900) }; }`, host(), null);
  assert.equal(out.ok && out.reason?.length, 500);
});

test("CPU limit stops a busy loop", async () => {
  const started = Date.now();
  const out = await runCheck(`async function check() { for (;;) {} }`, host(), null, { ...DEFAULT_LIMITS, cpuMs: 100 });
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /interrupted|CPU/i);
  assert.ok(Date.now() - started < 5_000);
});

test("memory limit", async () => {
  const out = await runCheck(
    `async function check() { const a = []; for (;;) a.push("x".repeat(1e5)); }`,
    host(),
    null,
    { ...DEFAULT_LIMITS, memoryBytes: 4 * 1024 * 1024, cpuMs: 5_000 }
  );
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.thrown, false);
});

test("wall clock limit while awaiting a slow host call", async () => {
  const out = await runCheck(
    `async function check(gene) { await gene.fetch("https://slow"); return { fire: true }; }`,
    host({ fetch: () => new Promise(() => {}) }),
    null,
    { ...DEFAULT_LIMITS, wallMs: 200 }
  );
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /wall/i);
});

test("a check that never settles errors instead of hanging", async () => {
  const out = await runCheck(`async function check() { await new Promise(() => {}); }`, host(), null);
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /did not settle/);
});

test("call budget", async () => {
  const out = await runCheck(
    `async function check(gene) { for (let i = 0; i < 11; i++) await gene.exec("glab", ["api", "x"]); return { fire: false }; }`,
    host(),
    null
  );
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /more than 10/);
});

test("state too large or not JSON", async () => {
  const big = await runCheck(`async function check(gene) { gene.state = "x".repeat(20000); return { fire: false }; }`, host(), null);
  assert.match(!big.ok ? big.error : "", /state/);
  const cyc = await runCheck(`async function check(gene) { const a = {}; a.a = a; gene.state = a; return { fire: false }; }`, host(), null);
  assert.equal(cyc.ok, false);
});

test("log lines are captured and capped", async () => {
  const out = await runCheck(`async function check(gene) { for (let i = 0; i < 30; i++) gene.log("l" + i); return { fire: false }; }`, host(), null);
  assert.equal(out.logs.length, 20);
  assert.equal(out.logs[0], "l0");
});

// Final review I2: error messages and log lines leave the sandbox into the DB, the TUI and
// tracker comments, so each is size-capped, not just counted.
test("error message and log lines are length-capped", async () => {
  const thrown = await runCheck(`async function check() { throw new Error("x".repeat(100000)); }`, host(), null);
  assert.ok(!thrown.ok && thrown.error.length <= 1000);
  const logged = await runCheck(`async function check(gene) { gene.log("y".repeat(100000)); return { fire: false }; }`, host(), null);
  assert.equal(logged.logs[0]!.length, 500);
});
