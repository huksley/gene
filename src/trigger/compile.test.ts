import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckHost } from "./sandbox.ts";
import {
  normaliseTriggerProse,
  proseHash,
  buildCompilePrompt,
  parseCompileReply,
  trialRun,
  compileTrigger
} from "./compile.ts";

const reply = (code: string, interval = "1m", summary = "Hourly") =>
  `SUMMARY: ${summary}\nINTERVAL: ${interval}\n\`\`\`js\n${code}\n\`\`\`\n`;

/** A trial host whose exec reports the given problem lines (as the real host would collect them). */
const stubHost = (problemsPerRun: string[] = []): CheckHost & { problems: string[] } => {
  const problems: string[] = [];
  return {
    problems,
    cron: () => false,
    fetch: async () => ({ status: 200, headers: {}, text: "{\"items\":[]}" }),
    exec: async () => {
      problems.push(...problemsPerRun);
      return { code: 0, stdout: "[]", stderr: "" };
    },
    now: () => new Date("2026-10-07T09:00:00Z")
  };
};

const opts = (hosts: (() => CheckHost & { problems: string[] })[] | (() => CheckHost & { problems: string[] })) => ({
  execAllow: ["glab api"],
  ioFloorMin: 5,
  trialHost: Array.isArray(hosts) ? () => hosts.shift()!() : hosts
});

test("normaliseTriggerProse: manual/none/empty mean no trigger", () => {
  for (const s of ["", "  ", "manual", "None", " MANUAL \n"]) assert.equal(normaliseTriggerProse(s), null);
  assert.equal(normaliseTriggerProse("  every hour \n"), "every hour");
});

test("proseHash is stable and differs by content", () => {
  assert.equal(proseHash("every hour"), proseHash("every hour"));
  assert.notEqual(proseHash("every hour"), proseHash("every day"));
  assert.match(proseHash("x"), /^[0-9a-f]{64}$/);
});

test("prompt lists allowed exec prefixes and the previous error", () => {
  const p = buildCompilePrompt("every hour", { execAllow: ["glab api"], ioFloorMin: 5, previousError: "boom" });
  assert.match(p, /every hour/);
  assert.match(p, /`glab api`/);
  assert.match(p, /boom/);
  assert.match(buildCompilePrompt("x", { execAllow: [], ioFloorMin: 5 }), /`gene.exec` is not available/);
});

test("parseCompileReply: ok", () => {
  const r = parseCompileReply(reply(`async function check(gene) { return { fire: gene.cron("0 * * * *") }; }`, "15m", "Every hour"));
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") {
    assert.equal(r.trigger.summary, "Every hour");
    assert.equal(r.trigger.intervalSec, 900);
    assert.match(r.trigger.code, /function check/);
  }
});

test("parseCompileReply: uncompilable", () => {
  assert.deepEqual(parseCompileReply("UNCOMPILABLE: no schedule or condition"), { kind: "uncompilable", reason: "no schedule or condition" });
});

test("parseCompileReply: missing parts are invalid", () => {
  assert.equal(parseCompileReply("hello").kind, "invalid");
  assert.equal(parseCompileReply("SUMMARY: x\nINTERVAL: soon\n```js\nx\n```").kind, "invalid");
});

test("trialRun reports the real verdict and any exec problems", async () => {
  const ok = await trialRun(`async function check(gene) { await gene.exec("glab", ["api", "x"]); return { fire: true, reason: "r" }; }`, stubHost(["Error: not logged in"]));
  assert.deepEqual(ok, { fire: true, reason: "r", problems: ["Error: not logged in"] });
});

test("trialRun: a throw on real data is an error", async () => {
  const r = await trialRun(`async function check(gene) { const x = await gene.fetch("https://x"); return { fire: x.json().nope.length > 0 }; }`, stubHost());
  assert.ok(r.error);
});

test("compileTrigger retries once with the trial error", async () => {
  const prompts: string[] = [];
  const answers = [reply(`async function check() { return 1; }`), reply(`async function check() { return { fire: false }; }`)];
  const result = await compileTrigger("every hour", async p => (prompts.push(p), answers.shift()!), opts(() => stubHost()));
  assert.equal(result.kind, "ok");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /must return/);
});

test("compileTrigger feeds exec problems back on the first attempt", async () => {
  const prompts: string[] = [];
  const code = `async function check(gene) { await gene.exec("glab", ["api", "x"]); return { fire: false }; }`;
  const result = await compileTrigger("my MRs", async p => (prompts.push(p), reply(code)), opts([() => stubHost(["glab api: exit 1: unknown flag"]), () => stubHost()]));
  assert.equal(result.kind, "ok");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /unknown flag/);
  if (result.kind === "ok") assert.deepEqual(result.trial.problems, []);
});

test("compileTrigger accepts code whose commands still report problems on the retry", async () => {
  const code = `async function check(gene) { await gene.exec("glab", ["api", "x"]); return { fire: false }; }`;
  const result = await compileTrigger("my MRs", async () => reply(code), opts(() => stubHost(["Error: not logged in"])));
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.deepEqual(result.trial, { fire: false, reason: undefined, problems: ["Error: not logged in"] });
  }
});

test("compileTrigger gives up after the retry on a code error", async () => {
  const result = await compileTrigger("every hour", async () => reply(`nope(`), opts(() => stubHost()));
  assert.equal(result.kind, "invalid");
});

test("compileTrigger does not retry an UNCOMPILABLE answer", async () => {
  let calls = 0;
  const result = await compileTrigger("vibes", async () => (calls++, "UNCOMPILABLE: no schedule"), opts(() => stubHost()));
  assert.deepEqual([result.kind, calls], ["uncompilable", 1]);
});

test("compileTrigger: runner failure is invalid, not a throw", async () => {
  const result = await compileTrigger("every hour", async () => { throw new Error("claude exited 1"); }, opts(() => stubHost()));
  assert.equal(result.kind, "invalid");
});
