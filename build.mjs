/**
 * Build the standalone `gene` executable (macOS arm64).
 *
 *   1. esbuild bundles src/index.ts and its whole import graph into a single ESM
 *      file (dist/gene.js). String-literal dynamic imports of local modules
 *      (./ui/app.ts, ./import-legacy.ts) and of @electric-sql/pglite are inlined.
 *   2. `node --build-sea sea.json` wraps that bundle — plus the embedded assets
 *      (PGlite WASM, the OpenTUI dylib, package.json) — into ./gene.
 *   3. On macOS the result is signed: ad-hoc by default, or with a Developer ID
 *      (hardened runtime + entitlements.plist) when GENE_CODESIGN_IDENTITY is set,
 *      then notarized by Apple when GENE_NOTARY_PROFILE names a `notarytool
 *      store-credentials` keychain profile.
 *
 * Notes on the externals below:
 *   - The OpenTUI platform packages are referenced by dynamic import inside
 *     @opentui/core; mark them external so esbuild leaves them as runtime imports.
 *     None of them runs in the binary: index.ts extracts the embedded dylib and
 *     points OTUI_ASSET_ROOT at it, which OpenTUI checks before importing.
 *   - pg's optional native/edge deps are external (never loaded in this config).
 */

import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const root = fileURLToPath(new URL(".", import.meta.url));
const p = (...s) => path.join(root, ...s);

/**
 * @opentui/core lazily loads tree-sitter grammars with `import(x, { with: { type:
 * "file" } })` — an import-attribute form esbuild can't bundle. Those imports live in
 * loadParsers(), reached only via the syntax highlighter, which our dashboard never
 * uses (it renders layout primitives only). Resolve them to a stub that yields the
 * asset's path string so the bundle builds; the value is inert because it's never read.
 */
const stubFileAttrImports = {
  name: "stub-file-attr-imports",
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.with && args.with.type === "file") {
        return { path: args.path, namespace: "opentui-file-stub" };
      }
      return null;
    });
    build.onLoad({ filter: /.*/, namespace: "opentui-file-stub" }, args => ({
      contents: `export default ${JSON.stringify(args.path)};`,
      loader: "js",
    }));
  },
};

console.log("• bundling src/index.ts → dist/gene.js");
await esbuild.build({
  entryPoints: [p("src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  outfile: p("dist", "gene.js"),
  plugins: [stubFileAttrImports],
  // `pg` is CommonJS and calls require() for Node builtins. In ESM output there is no
  // `require`, so esbuild's __require shim throws — but it first checks for a real
  // `require` in scope and delegates to it. Provide one via createRequire. Under the
  // SEA, import.meta.url is the binary's own file URL, which still resolves builtins.
  banner: {
    js: [
      "import { createRequire as __geneCreateRequire } from 'node:module';",
      "import { fileURLToPath as __geneFileURLToPath } from 'node:url';",
      "import { dirname as __geneDirname } from 'node:path';",
      "const require = __geneCreateRequire(import.meta.url);",
      "const __filename = __geneFileURLToPath(import.meta.url);",
      "const __dirname = __geneDirname(__filename);",
    ].join("\n"),
  },
  external: [
    // pg optional deps — not used with a TCP/embedded config
    "pg-native",
    "pg-cloudflare",
    "cloudflare:sockets",
    // OpenTUI platform packages for other targets (not installed, never run here)
    "@opentui/core-darwin-arm64",
    "@opentui/core-darwin-x64",
    "@opentui/core-linux-x64",
    "@opentui/core-linux-x64-musl",
    "@opentui/core-linux-arm64",
    "@opentui/core-linux-arm64-musl",
    "@opentui/core-win32-x64",
    "@opentui/core-win32-arm64",
  ],
  logLevel: "info",
  legalComments: "none",
});

console.log("• building single executable → ./gene");
execFileSync(process.execPath, ["--build-sea", p("sea.json")], {
  stdio: "inherit",
  cwd: root,
});

// Signing. Without GENE_CODESIGN_IDENTITY the binary is signed ad-hoc (enough to run
// locally; install.sh / `gene --update` keep any valid signature as-is). With it,
// it's signed with that Developer ID under the hardened runtime — V8's JIT and the
// extracted (unsigned) OpenTUI dylib need the entitlements in entitlements.plist —
// and, with GENE_NOTARY_PROFILE, submitted to Apple's notary service. A Developer ID
// or notarization failure aborts the build: a release must never silently ship unsigned.
const signIdentity = process.env.GENE_CODESIGN_IDENTITY?.trim();
const notaryProfile = process.env.GENE_NOTARY_PROFILE?.trim();
if (notaryProfile && !signIdentity) {
  console.error("✗ GENE_NOTARY_PROFILE requires GENE_CODESIGN_IDENTITY (only a Developer ID signature can be notarized)");
  process.exit(1);
}

if (process.platform === "darwin" && signIdentity) {
  console.log(`• codesigning ./gene as "${signIdentity}"`);
  execFileSync(
    "codesign",
    ["--force", "--options", "runtime", "--timestamp", "--entitlements", p("entitlements.plist"), "--sign", signIdentity, p("gene")],
    { stdio: "inherit" }
  );
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", p("gene")], { stdio: "inherit" });

  if (notaryProfile) {
    // notarytool takes a zip/dmg/pkg, not a bare Mach-O; the ticket can't be stapled
    // to a bare binary either, so Gatekeeper looks it up online on first launch.
    const zip = p("dist", "gene-notarize.zip");
    fs.rmSync(zip, { force: true });
    execFileSync("ditto", ["-c", "-k", "--keepParent", p("gene"), zip]);
    console.log(`• notarizing with keychain profile "${notaryProfile}" (waits for Apple)`);
    const out = execFileSync(
      "xcrun",
      ["notarytool", "submit", zip, "--keychain-profile", notaryProfile, "--wait", "--output-format", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
    );
    const { id, status } = JSON.parse(out);
    if (status !== "Accepted") {
      console.error(`✗ notarization ${status} — see: xcrun notarytool log ${id} --keychain-profile ${notaryProfile}`);
      process.exit(1);
    }
    console.log(`• notarized (submission ${id})`);
  }
} else if (process.platform === "darwin") {
  try {
    execFileSync("codesign", ["--sign", "-", "--force", p("gene")], {
      stdio: "inherit",
    });
    console.log("• ad-hoc codesigned ./gene");
  } catch (err) {
    console.warn("! codesign failed (continuing):", err.message);
  }
}

fs.chmodSync(p("gene"), 0o755);

// Package the release artifact: gzip the binary and write its sha256. This `.gz` is
// what gets uploaded to the GitHub release; `gene --update` and install.sh download it
// and decompress on install. Keep the asset name in sync with ASSET_CANDIDATES.
const asset = "gene-macos-arm64";
console.log(`• packaging release artifact → ${asset}.gz`);
await pipeline(fs.createReadStream(p("gene")), zlib.createGzip({ level: 9 }), fs.createWriteStream(p(`${asset}.gz`)));
const sha = crypto.createHash("sha256").update(fs.readFileSync(p(`${asset}.gz`))).digest("hex");
fs.writeFileSync(p(`${asset}.gz.sha256`), `${sha}  ${asset}.gz\n`);
const gzMB = (fs.statSync(p(`${asset}.gz`)).size / 1e6).toFixed(1);
console.log(`✓ done — ./gene  +  ${asset}.gz (${gzMB} MB) + .sha256`);
