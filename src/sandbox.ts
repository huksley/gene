/**
 * Locates and runs the microsandbox driver (sandbox/sandbox.sh).
 *
 * The script and its Dockerfile build context are embedded as SEA assets so the
 * standalone binary is self-contained. In a SEA we extract both into one temp dir
 * (sandbox.sh derives its SCRIPT_DIR from BASH_SOURCE, so co-locating the Dockerfile
 * keeps `$SCRIPT_DIR/Dockerfile` resolving). In development we run them straight from
 * the repo. The path is memoised — extraction happens at most once per process.
 *
 * Used in two places: `invoke.ts` wraps each agent run in `sandbox.sh run …` when
 * GENE_SANDBOX is set, and `gene sandbox …` (see index.ts) forwards arbitrary
 * subcommands (base/run/versions/…) straight to the script.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { REPO_ROOT } from "./config.ts";
import { inSea, extractAssetTo } from "./sea-assets.ts";

/** Resolved sandbox.sh path, cached after the first call. */
let cached: string | undefined;

/**
 * Absolute path to a runnable sandbox.sh. In a SEA this extracts the embedded
 * sandbox.sh + Dockerfile to a shared temp dir and returns the script path; in
 * development it returns the in-repo path.
 */
export const sandboxScriptPath = (): string => {
  if (cached) return cached;
  if (inSea()) {
    // The Dockerfile must sit next to sandbox.sh for `$SCRIPT_DIR/Dockerfile` to resolve.
    extractAssetTo("gene-sandbox", "Dockerfile", "Dockerfile", 0o644);
    cached = extractAssetTo("gene-sandbox", "sandbox.sh", "sandbox.sh", 0o755);
  } else {
    cached = path.join(REPO_ROOT, "sandbox", "sandbox.sh");
  }
  return cached;
};

/**
 * Run `sandbox.sh <args…>` with the daemon's environment, streaming its stdio.
 * Resolves with the exit code (127 if the script can't be launched at all).
 */
export const runSandbox = (args: string[]): Promise<number> =>
  new Promise(resolve => {
    const proc = spawn(sandboxScriptPath(), args, { stdio: "inherit", env: process.env });
    proc.on("error", error => {
      process.stderr.write(
        `gene sandbox: cannot launch sandbox.sh — ${error instanceof Error ? error.message : String(error)}\n`
      );
      resolve(127);
    });
    proc.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 0));
  });
