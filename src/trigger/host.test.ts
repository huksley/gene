import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { cronDue, execAllowed, execProblem, createHost } from "./host.ts";

const at = (iso: string) => new Date(iso);

test("cronDue: tick inside (windowStart, now]", () => {
  assert.equal(cronDue("0 * * * *", undefined, at("2026-10-07T08:59:00Z"), at("2026-10-07T09:00:30Z")), true);
  assert.equal(cronDue("0 * * * *", undefined, at("2026-10-07T09:00:00Z"), at("2026-10-07T09:30:00Z")), false);
});

test("cronDue: long downtime catches up once (a single boolean for the whole window)", () => {
  assert.equal(cronDue("0 * * * *", undefined, at("2026-10-07T00:30:00Z"), at("2026-10-07T10:30:00Z")), true);
});

test("cronDue: honours tz", () => {
  // 09:00 Europe/Berlin (CEST, UTC+2) = 07:00Z
  assert.equal(cronDue("0 9 * * *", "Europe/Berlin", at("2026-10-07T06:59:00Z"), at("2026-10-07T07:00:10Z")), true);
  assert.equal(cronDue("0 9 * * *", undefined, at("2026-10-07T06:59:00Z"), at("2026-10-07T07:00:10Z")), false);
});

test("cronDue: invalid expression throws", () => {
  assert.throws(() => cronDue("not cron", undefined, at("2026-10-07T00:00:00Z"), at("2026-10-07T01:00:00Z")));
});

test("execAllowed: whole-token prefixes", () => {
  const allow = ["glab api", "argocd app list"];
  assert.equal(execAllowed("glab", ["api", "merge_requests"], allow), undefined);
  assert.equal(execAllowed("argocd", ["app", "list", "-o", "json"], allow), undefined);
  assert.match(execAllowed("glab", ["apix"], allow) ?? "", /not allowed/);
  assert.match(execAllowed("argocd", ["app", "sync", "x"], allow) ?? "", /not allowed/);
  assert.match(execAllowed("rm", ["-rf", "/"], []) ?? "", /not allowed/);
});

test("execAllowed: glab api write flags rejected", () => {
  for (const flag of [["-X", "POST"], ["-XPOST"], ["--method", "PUT"], ["--method=PUT"], ["-f", "a=b"], ["-F", "a=b"], ["--field", "a=b"], ["--raw-field", "a=b"], ["--input", "f"]]) {
    assert.match(execAllowed("glab", ["api", "x", ...flag], ["glab api"]) ?? "", /read-only/, flag.join(" "));
  }
});

test("exec runs without a shell, captures output and exit code", async () => {
  const host = createHost({ windowStart: new Date(), now: new Date(), execAllow: [process.execPath] });
  const r = await host.exec(process.execPath, ["-e", "process.stdout.write('hi $(whoami)'); process.exit(3)"]);
  assert.deepEqual(r, { code: 3, stdout: "hi $(whoami)", stderr: "" });
});

test("exec rejects commands off the allowlist", async () => {
  const host = createHost({ windowStart: new Date(), now: new Date(), execAllow: [] });
  await assert.rejects(host.exec("ls", []), /not allowed/);
});

test("exec truncates huge output", async () => {
  const host = createHost({ windowStart: new Date(), now: new Date(), execAllow: [process.execPath] });
  const r = await host.exec(process.execPath, ["-e", "process.stdout.write('x'.repeat(3*1024*1024))"]);
  assert.equal(r.stdout.length, 1024 * 1024);
});

test("fetch: http(s) only", async () => {
  const host = createHost({ windowStart: new Date(), now: new Date(), execAllow: [] });
  await assert.rejects(host.fetch("file:///etc/passwd", {}), /http/);
});

test("fetch: returns status, headers, text", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("x-a", "1");
    res.statusCode = 503;
    res.end("down");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const host = createHost({ windowStart: new Date(), now: new Date(), execAllow: [] });
    const r = await host.fetch(`http://127.0.0.1:${port}/`, {});
    assert.equal(r.status, 503);
    assert.equal(r.text, "down");
    assert.equal(r.headers["x-a"], "1");
  } finally {
    server.close();
  }
});

test("execProblem: non-zero exit", () => {
  assert.equal(execProblem("argocd", ["app", "list"], { code: 20, stdout: "", stderr: "FATA[0000] not logged in\n" }), "argocd app: exit 20: FATA[0000] not logged in");
});

test("execProblem: error keyword in stderr with exit 0", () => {
  assert.equal(execProblem("glab", ["api", "x"], { code: 0, stdout: "[]", stderr: "note\nError: not logged in\n" }), "Error: not logged in");
});

test("execProblem: clean or merely noisy stderr is fine", () => {
  assert.equal(execProblem("glab", ["api", "x"], { code: 0, stdout: "[]", stderr: "" }), undefined);
  assert.equal(execProblem("glab", ["api", "x"], { code: 0, stdout: "[]", stderr: "warning: deprecated flag\n" }), undefined);
  // stdout content is data, never scanned
  assert.equal(execProblem("glab", ["api", "x"], { code: 0, stdout: "{\"title\":\"fix error page\"}", stderr: "" }), undefined);
});

test("createHost collects exec problems; fetch status codes are never problems", async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 503;
    res.end("down");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const host = createHost({ windowStart: new Date(), now: new Date(), execAllow: [process.execPath] });
    await host.fetch(`http://127.0.0.1:${port}/`, {});
    assert.deepEqual(host.problems, []);
    await host.exec(process.execPath, ["-e", "process.stderr.write('Exception: boom\\n')"]);
    assert.deepEqual(host.problems, ["Exception: boom"]);
  } finally {
    server.close();
  }
});
