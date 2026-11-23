import { test } from "node:test";
import assert from "node:assert/strict";
import { ingest, newSession, promptText, sessionKind, ticketCandidates, tokenTotals, prLabel } from "./parse.ts";

const base = (extra: Record<string, unknown>) => ({
  cwd: "/Users/me/src/nest",
  gitBranch: "ruslan/cloud-2688-rate-limit",
  entrypoint: "cli",
  version: "2.1.330",
  sessionId: "s1",
  ...extra
});

test("folds prompts, replies, tools, usage, title and PRs", () => {
  const acc = newSession("s1");
  ingest(acc, base({ type: "user", timestamp: "2026-11-20T10:00:00Z", message: { role: "user", content: "Fix CLOUD-2688 and look at utf-8 handling" } }));
  ingest(acc, base({ type: "assistant", timestamp: "2026-11-20T10:01:00Z", message: { id: "m1", content: [{ type: "text", text: "On it." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr create --fill" } }], usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } } }));
  // The same message streamed again: usage counted once.
  ingest(acc, base({ type: "assistant", timestamp: "2026-11-20T10:01:01Z", message: { id: "m1", content: [], usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 7 } } }));
  ingest(acc, base({ type: "user", timestamp: "2026-11-20T10:02:00Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "https://github.com/acme/nest/pull/481\n" }] } }));
  ingest(acc, { type: "ai-title", aiTitle: "Rate limit the instances API", sessionId: "s1" });
  ingest(acc, { type: "pr-link", prUrl: "https://github.com/acme/docs/pull/7", prNumber: 7, prRepository: "acme/docs", timestamp: "2026-11-20T10:03:00Z" });
  ingest(acc, { type: "cost-state", totalCostUSD: 1.25, totalLinesAdded: 40, totalLinesRemoved: "3" });

  assert.equal(acc.prompts, 1, "a tool result is not a prompt");
  assert.equal(acc.title, "Rate limit the instances API");
  assert.equal(acc.lastReply, "On it.");
  assert.deepEqual([...acc.tools], [["Bash", 1]]);
  assert.deepEqual(tokenTotals(acc), { in: 100, out: 7 });
  assert.deepEqual([...acc.prs.keys()].sort(), ["https://github.com/acme/docs/pull/7", "https://github.com/acme/nest/pull/481"]);
  assert.equal(acc.costUsd, 1.25);
  assert.deepEqual(acc.lines, { added: 40, removed: 3 });
  assert.equal(acc.firstAt, "2026-11-20T10:00:00Z");
  assert.equal(acc.lastAt, "2026-11-20T10:02:00Z");
  assert.equal(sessionKind(acc), "interactive");
});

test("PR URLs in ordinary tool output are not PRs the session opened", () => {
  const acc = newSession("s1");
  ingest(acc, base({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr list" } }] } }));
  ingest(acc, base({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "https://github.com/acme/nest/pull/1" }] } }));
  assert.equal(acc.prs.size, 0);
});

test("tickets: worktree, branch, title and prompt mentions — known keys only", () => {
  const acc = newSession("s1");
  ingest(acc, base({ type: "user", cwd: "/Users/me/src/nest/.gene/repos/.worktrees/acme/nest/CLOUD-2629", gitBranch: "feature/CLOUD-2629-check", entrypoint: "sdk-cli", message: { content: "see also cloud-3000, gpt-4 and utf-8" } }));
  ingest(acc, base({ type: "user", gitBranch: "ruslan/cloud-2688-rate-limit", message: { content: "and TOKEN-33" } }));
  const ids = ticketCandidates(acc, new Set(["CLOUD", "TOKEN"])).map(c => `${c.identifier}:${c.via}`);
  assert.deepEqual(ids, ["CLOUD-2629:worktree", "CLOUD-2688:branch", "CLOUD-3000:prompt", "TOKEN-33:prompt"]);
  assert.equal(sessionKind(acc), "gene");
  // No keys known: only identifiers written in capitals count.
  assert.deepEqual(ticketCandidates(acc, new Set()).map(c => c.identifier), ["CLOUD-2629", "TOKEN-33"]);
});

test("promptText skips injected context and shows slash commands", () => {
  assert.equal(promptText("<command-name>/review</command-name><command-args>123</command-args>"), "/review 123");
  assert.equal(promptText("<local-command-stdout>ok</local-command-stdout>"), undefined);
  assert.equal(promptText([{ type: "tool_result", content: "x" }]), undefined);
  assert.equal(promptText([{ type: "text", text: "hello" }]), "hello");
});

test("Gene's brief names its ticket's title", () => {
  const acc = newSession("s1");
  const brief = `You are **Gene**…\n${"x".repeat(2000)}\n# Issue\n\n- **ID:** CLOUD-1\n- **Title:** Fix the thing\n`;
  ingest(acc, base({ type: "user", cwd: "/r/.gene/repos/.worktrees/acme/app/CLOUD-1", message: { content: brief } }));
  assert.equal(acc.geneTitle, "Fix the thing");
  const program = newSession("s2");
  ingest(program, base({ type: "user", message: { content: "# Program: OPS-2 — Nightly report\n…" } }));
  assert.equal(program.geneTitle, "Nightly report");
});

test("sidechain records and headless runs", () => {
  const acc = newSession("s1");
  ingest(acc, base({ type: "user", isSidechain: true, message: { content: "subagent prompt" } }));
  assert.equal(acc.prompts, 0);
  ingest(acc, base({ type: "user", entrypoint: "sdk-ts", message: { content: "run" } }));
  assert.equal(sessionKind(acc), "headless");
  assert.equal(prLabel("https://gitlab.example.com/g/r/-/merge_requests/12"), "!12");
});
