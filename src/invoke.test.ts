import { test } from "node:test";
import assert from "node:assert/strict";
import { composeAllowedTools } from "./invoke.ts";

test("composeAllowedTools includes forge tools when a forge is present", () => {
  const out = composeAllowedTools({
    base: ["Bash(git *)"],
    tracker: ["Bash(linear *)"],
    forge: ["Bash(gh *)"],
    global: ["Bash(curl *)"],
    extra: ["Bash(pup *)"]
  });
  assert.deepEqual(out, ["Bash(git *)", "Bash(linear *)", "Bash(gh *)", "Bash(curl *)", "Bash(pup *)"]);
});

test("composeAllowedTools omits forge tools when there is no forge (repo-less program)", () => {
  const out = composeAllowedTools({
    base: ["Bash(git *)"],
    tracker: ["Bash(linear *)"],
    extra: ["Bash(pup *)"]
  });
  assert.deepEqual(out, ["Bash(git *)", "Bash(linear *)", "Bash(pup *)"]);
});
