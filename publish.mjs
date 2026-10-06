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

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

/**
 * Release notes from the commits since the previous release tag: each commit's
 * subject as a heading and its body below (minus Co-Authored-By trailers). We push
 * straight to main, so `gh --generate-notes` (which lists merged PRs) would come out
 * empty — and `gene --update` shows these notes as its "what's new" preview.
 */
const releaseNotes = () => {
  spawnSync("git", ["fetch", "--tags", "--quiet"], { cwd: root, stdio: "ignore" });
  const previous = git("tag", "--list", "v*", "--sort=-v:refname", "--merged", "HEAD").split("\n").find(t => t && t !== tag);
  const range = previous ? `${previous}..HEAD` : "HEAD";
  const log = git("log", "--no-merges", "--format=%x1e%s%x1f%b", range);
  const sections = log
    .split("\x1e")
    .filter(Boolean)
    .map(entry => {
      const [subject, body = ""] = entry.split("\x1f");
      const text = body
        .split("\n")
        .filter(line => !/^\s*Co-Authored-By:/i.test(line))
        .join("\n")
        .trim();
      return `### ${subject.trim()}${text ? `\n${text}` : ""}`;
    });
  const compare = previous ? `\n\n**Full Changelog**: https://github.com/${REPO}/compare/${previous}...${tag}` : "";
  return `${sections.join("\n\n") || "_No changes recorded._"}${compare}\n`;
};

if (process.argv.includes("--notes")) {
  process.stdout.write(releaseNotes());
  process.exit(0);
}


// `gh` must be installed and authenticated before we touch the release.
if (spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status !== 0) {
  console.error("✗ the GitHub CLI `gh` is required and must be authenticated — run `gh auth login`.");
  process.exit(1);
}

// 1. Rebuild so the published binary matches the current source. build.mjs signs with
// GENE_CODESIGN_IDENTITY and notarizes with GENE_NOTARY_PROFILE when they're set.
if (!process.env.GENE_CODESIGN_IDENTITY?.trim()) {
  console.warn("! GENE_CODESIGN_IDENTITY is not set — this release will be ad-hoc signed only (not notarized)");
}
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
  const notesFile = p("dist", "release-notes.md");
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  fs.writeFileSync(notesFile, releaseNotes());
  execFileSync("gh", ["release", "create", tag, "--repo", REPO, "--title", tag, "--target", git("rev-parse", "HEAD"), "--notes-file", notesFile], {
    stdio: "inherit"
  });
}

// 3. Upload the artifacts, clobbering any same-named assets from a previous run.
console.log(`• uploading ${ASSET}.gz + .sha256 → ${tag}`);
execFileSync("gh", ["release", "upload", tag, gz, sum, "--repo", REPO, "--clobber"], { stdio: "inherit" });

console.log(`✓ published ${tag} → https://github.com/${REPO}/releases/tag/${tag}`);
