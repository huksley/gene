import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue } from "../tracker/index.ts";

// A recorder plugin (pushes event kinds to a shared global) and a plugin whose handle
// throws — to prove the dispatcher fans out, isolates failures, and resolves a factory.
const dir = mkdtempSync(join(tmpdir(), "gene-plugins-"));
writeFileSync(
  join(dir, "recorder.ts"),
  // Read the shared array at push time (not at module eval) so each test can reset it.
  `export default { name: "recorder", handle(e) { ((globalThis).__geneTestEvents ??= []).push(e.kind); } };`
);
writeFileSync(
  join(dir, "boom.ts"),
  `export default () => ({ name: "boom", handle() { throw new Error("kaboom"); } });`
);
writeFileSync(join(dir, "ignored.test.ts"), `export default { name: "nope", handle() {} };`);

const issue = { id: "i1", identifier: "T-1", stateName: "Todo" } as Issue;

test("loads plugins from a GENE_PLUGINS directory and dispatches to each", async () => {
  process.env.GENE_PLUGINS = dir;
  // Dynamic import AFTER setting the env so config reads GENE_PLUGINS at module load.
  const { setupPlugins, dispatch } = await import("./index.ts");
  await setupPlugins();

  (globalThis as Record<string, unknown>).__geneTestEvents = [];
  await dispatch({ kind: "agent-started", issue, intent: "start-processing" });
  await dispatch({ kind: "issue-status-changed", issue, from: "Todo", to: "In Progress" });

  const seen = (globalThis as Record<string, unknown>).__geneTestEvents as string[];
  assert.deepEqual(seen, ["agent-started", "issue-status-changed"]);
});

test("a throwing plugin is isolated — others still receive the event", async () => {
  process.env.GENE_PLUGINS = dir;
  const { setupPlugins, dispatch } = await import("./index.ts");
  await setupPlugins();

  (globalThis as Record<string, unknown>).__geneTestEvents = [];
  // boom.ts throws; recorder.ts must still record, and dispatch must not reject.
  await dispatch({ kind: "pr-created", issue, url: "https://x/pr/1", forge: "github" });
  const seen = (globalThis as Record<string, unknown>).__geneTestEvents as string[];
  assert.deepEqual(seen, ["pr-created"]);
});

test("skips .test files when loading a directory", async () => {
  process.env.GENE_PLUGINS = dir;
  const { setupPlugins, dispatch } = await import("./index.ts");
  await setupPlugins();
  (globalThis as Record<string, unknown>).__geneTestEvents = [];
  await dispatch({ kind: "agent-finished", issue, status: "done" });
  // Only recorder records; the .test.ts file must have been ignored (it has no recorder).
  assert.deepEqual((globalThis as Record<string, unknown>).__geneTestEvents, ["agent-finished"]);
});
