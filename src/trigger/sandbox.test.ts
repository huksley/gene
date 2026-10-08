import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheck, DEFAULT_LIMITS, type CheckHost } from "./sandbox.ts";

const host = (over: Partial<CheckHost> = {}): CheckHost => ({
  cron: () => false,
  fetch: async () => ({ status: 200, headers: { "content-type": "application/json" }, text: "{\"ok\":true}" }),
  exec: async () => ({ code: 0, stdout: "[]", stderr: "" }),
  ...over
});

test("returns fire + reason; localStorage persists between runs", async () => {
  const code = `async function check() {
    const n = Number(localStorage.getItem("n") ?? "0") + 1;
    localStorage.setItem("n", n);
    return { fire: true, reason: "go " + n };
  }`;
  const first = await runCheck(code, host(), null);
  assert.deepEqual(first, { ok: true, fire: true, reason: "go 1", state: { n: "1" }, logs: [], usedIo: false });
  const second = await runCheck(code, host(), first.ok ? first.state : null);
  assert.equal(second.ok && second.reason, "go 2");
});

test("localStorage is the Web Storage shape", async () => {
  const out = await runCheck(
    `async function check() {
       localStorage.setItem("a", 1); localStorage.setItem("b", "x");
       localStorage.removeItem("b");
       return { fire: false, reason: [localStorage.getItem("a"), localStorage.getItem("b"), localStorage.length, localStorage.key(0)].join(",") };
     }`,
    host(),
    { stale: "keep" }
  );
  assert.equal(out.ok && out.reason, "1,,2,stale");
});

test("a non-object stored state starts localStorage empty", async () => {
  const out = await runCheck(`async function check() { return { fire: false, reason: String(localStorage.length) }; }`, host(), [1, 2]);
  assert.equal(out.ok && out.reason, "0");
});

test("cron is a synchronous global and passes tz", async () => {
  const seen: unknown[] = [];
  const out = await runCheck(
    `async function check() { return { fire: cron("0 9 * * 1-5", { tz: "Europe/Berlin" }) }; }`,
    host({ cron: (e, tz) => (seen.push([e, tz]), true) }),
    null
  );
  assert.equal(out.ok && out.fire, true);
  assert.deepEqual(seen, [["0 9 * * 1-5", "Europe/Berlin"]]);
});

test("fetch returns a Response-like object", async () => {
  const out = await runCheck(
    `async function check() {
       const res = await fetch("https://x/health", { method: "GET" });
       const body = await res.json();
       return { fire: res.ok && res.status === 200 && body.ok === true, reason: res.headers.get("Content-Type") + "|" + (await res.text()) };
     }`,
    host(),
    null
  );
  assert.deepEqual(out.ok && [out.fire, out.reason, out.usedIo], [true, "application/json|{\"ok\":true}", true]);
});

test("fetch: a non-2xx status is data, res.ok is false", async () => {
  const out = await runCheck(
    `async function check() { const r = await fetch("https://x"); return { fire: !r.ok, reason: String(r.status) }; }`,
    host({ fetch: async () => ({ status: 503, headers: {}, text: "down" }) }),
    null
  );
  assert.deepEqual(out.ok && [out.fire, out.reason], [true, "503"]);
});

test("exec returns { exitCode, stdout, stderr } and does not throw on a non-zero exit", async () => {
  const out = await runCheck(
    `async function check() { const r = await exec("glab", ["api", "x"]); return { fire: r.exitCode !== 0, reason: r.exitCode + ":" + r.stderr }; }`,
    host({ exec: async () => ({ code: 2, stdout: "", stderr: "nope" }) }),
    null
  );
  assert.deepEqual(out.ok && [out.fire, out.reason], [true, "2:nope"]);
});

test("Date is the real clock", async () => {
  const before = Date.now();
  const out = await runCheck(`async function check() { return { fire: false, reason: String(Date.now()) }; }`, host(), null);
  const t = Number(out.ok && out.reason);
  assert.ok(t >= before && t <= Date.now() + 1000);
});

test("console.* is captured", async () => {
  const out = await runCheck(
    `async function check() { console.log("a", 1, { b: 2 }); console.warn("w"); console.error("e"); return { fire: false }; }`,
    host(),
    null
  );
  assert.deepEqual(out.logs, ["a 1 {\"b\":2}", "w", "e"]);
});

test("host rejection surfaces as a thrown error in the check", async () => {
  const out = await runCheck(
    `async function check() { await exec("rm", ["-rf", "/"]); return { fire: true }; }`,
    host({ exec: async () => { throw new Error("exec not allowed: rm"); } }),
    null
  );
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /exec not allowed: rm/);
  assert.equal(!out.ok && out.thrown, true);
});

test("no ambient capabilities, and the raw bridge is not reachable", async () => {
  const out = await runCheck(
    `async function check() { return { fire: false, reason: [typeof process, typeof require, typeof setTimeout, typeof __host_async, typeof __host_cron, typeof gene].join(",") }; }`,
    host(),
    null
  );
  assert.equal(out.ok && out.reason, "undefined,undefined,undefined,undefined,undefined,undefined");
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
    `async function check() { await fetch("https://slow"); return { fire: true }; }`,
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
    `async function check() { for (let i = 0; i < 11; i++) await exec("glab", ["api", "x"]); return { fire: false }; }`,
    host(),
    null
  );
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : "", /more than 10/);
});

test("localStorage too large", async () => {
  const big = await runCheck(`async function check() { localStorage.setItem("k", "x".repeat(20000)); return { fire: false }; }`, host(), null);
  assert.match(!big.ok ? big.error : "", /localStorage/);
});

test("console lines are captured and capped", async () => {
  const out = await runCheck(`async function check() { for (let i = 0; i < 30; i++) console.log("l" + i); return { fire: false }; }`, host(), null);
  assert.equal(out.logs.length, 20);
  assert.equal(out.logs[0], "l0");
});

// Final review I2: error messages and log lines leave the sandbox into the DB, the TUI and
// tracker comments, so each is size-capped, not just counted.
test("error message and log lines are length-capped", async () => {
  const thrown = await runCheck(`async function check() { throw new Error("x".repeat(100000)); }`, host(), null);
  assert.ok(!thrown.ok && thrown.error.length <= 1000);
  const logged = await runCheck(`async function check() { console.log("y".repeat(100000)); return { fire: false }; }`, host(), null);
  assert.equal(logged.logs[0]!.length, 500);
});
