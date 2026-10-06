import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { pipeLines, run, runOrThrow } from "./exec.ts";

// A child that exits cleanly within the timeout resolves normally.
test("run resolves a fast command before its timeout", async () => {
  const result = await run("node", ["-e", "process.stdout.write('ok')"], { timeout: 5_000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ok");
});

// A child that hangs past the timeout is killed and rejected, rather than
// stalling the caller forever (the scan-loop freeze this guards against).
test("run rejects and kills a command that exceeds its timeout", async () => {
  const start = Date.now();
  await assert.rejects(
    () => run("node", ["-e", "setTimeout(() => {}, 60_000)"], { timeout: 150 }),
    /timed out/i
  );
  // Should reject ~at the timeout, not hang for the full 60s.
  assert.ok(Date.now() - start < 5_000, "rejected promptly at the timeout");
});

// runOrThrow surfaces the same timeout error.
test("runOrThrow rejects on timeout", async () => {
  await assert.rejects(
    () => runOrThrow("node", ["-e", "setTimeout(() => {}, 60_000)"], { timeout: 150 }),
    /timed out/i
  );
});

// Progress meters must reach the log as one clean line each: last `\r` frame only,
// cursor/erase escapes stripped (they'd scribble over the TUI), colors kept.
test("pipeLines collapses redraw frames and strips non-color escapes", async () => {
  const stream = new PassThrough();
  const lines: string[] = [];
  pipeLines(stream, line => lines.push(line));
  stream.write("layer 1/15 \x1b[32m10%\x1b[0m\rlayer 1/15 \x1b[32m100%\x1b[0m\x1b[K\n");
  stream.write("\x1b[2A\x1b]0;title\x07plain\n\n  \n");
  stream.end("tail");
  await new Promise(resolve => stream.on("end", resolve));
  assert.deepEqual(lines, ["layer 1/15 \x1b[32m100%\x1b[0m", "plain", "tail"]);
});
