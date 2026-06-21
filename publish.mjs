/**
 * Publish the standalone binary to a GitHub release.
 *
 *   npm run publish
 *
 * Rebuilds the release artifacts (so the upload always matches the current source),
 * ensures a GitHub release exists for the package.json version (tag `vX.Y.Z`), and
 * uploads the gzipped binary + its `.sha256` with `--clobber`. The matching installer
 * (`install.sh`) and `gene --update` download and decompress that `.gz`.
 *
 * Requires the `gh` CLI, authenticated against the repo (`gh auth login`).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));
const p = (...s) => path.join(root, ...s);

const REPO = "huksley/gene";
const ASSET = "gene-macos-arm64"; // keep in sync with build.mjs and ASSET_CANDIDATES

const { version } = JSON.parse(fs.readFileSync(p("package.json"), "utf8"));
const tag = `v${version}`;

// `gh` must be installed and authenticated before we touch the release.
if (spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status !== 0) {
  console.error("✗ the GitHub CLI `gh` is required and must be authenticated — run `gh auth login`.");
  process.exit(1);
}

// 1. Rebuild so the published binary matches the current source.
console.log("• building release artifacts");
execFileSync(process.execPath, [p("build.mjs")], { stdio: "inherit", cwd: root });

const gz = p(`${ASSET}.gz`);
const sum = p(`${ASSET}.gz.sha256`);
for (const f of [gz, sum]) {
  if (!fs.existsSync(f)) {
    console.error(`✗ missing artifact ${path.basename(f)} — build did not produce it.`);
    process.exit(1);
  }
}

// 2. Ensure a release exists for this version's tag (create it if missing).
if (spawnSync("gh", ["release", "view", tag, "--repo", REPO], { stdio: "ignore" }).status === 0) {
  console.log(`• release ${tag} exists — updating its assets`);
} else {
  console.log(`• creating release ${tag}`);
  execFileSync("gh", ["release", "create", tag, "--repo", REPO, "--title", tag, "--generate-notes"], {
    stdio: "inherit"
  });
}

// 3. Upload the artifacts, clobbering any same-named assets from a previous run.
console.log(`• uploading ${ASSET}.gz + .sha256 → ${tag}`);
execFileSync("gh", ["release", "upload", tag, gz, sum, "--repo", REPO, "--clobber"], { stdio: "inherit" });

console.log(`✓ published ${tag} → https://github.com/${REPO}/releases/tag/${tag}`);
