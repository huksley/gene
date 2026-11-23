/**
 * Build the standalone `gene` executables — macOS arm64, Linux x64 and Linux arm64 —
 * from any of those hosts.
 *
 *   node build.mjs                                  # every target (what a release ships)
 *   node build.mjs --target host                    # just this machine's platform
 *   node build.mjs --target linux-x64,darwin-arm64  # a chosen subset
 *
 *   1. esbuild bundles src/index.ts and its whole import graph into a single ESM
 *      file (dist/gene.js). String-literal dynamic imports of local modules
 *      (./ui/app.ts, ./import-legacy.ts) and of @electric-sql/pglite are inlined.
 *      The bundle is plain JS, so one bundle serves every target.
 *   2. Per target, `node --build-sea` wraps that bundle — plus the embedded assets
 *      (PGlite WASM, the target's OpenTUI native library, package.json) — into
 *      dist/<target>/gene. The SEA is injected into *that target's* Node binary
 *      (sea.json's `executable`): the running node for the host target, otherwise the
 *      same Node version for the target, downloaded from nodejs.org and verified
 *      against its SHASUMS256.txt. A target's OpenTUI package that npm didn't install
 *      (it only installs the host's) is fetched with `npm pack`. Both are cached under
 *      node_modules/.cache/gene-build.
 *   3. The macOS binary is signed. On a Mac: ad-hoc by default, or with a Developer ID
 *      (hardened runtime + entitlements.plist) when GENE_CODESIGN_IDENTITY is set,
 *      then notarized by Apple when GENE_NOTARY_PROFILE names a `notarytool
 *      store-credentials` keychain profile. On Linux: ad-hoc with `rcodesign` when it
 *      is on PATH, otherwise left unsigned — install.sh and `gene --update` ad-hoc sign
 *      an unsigned binary on the Mac they install it on.
 *   4. Each binary is gzipped to ./gene-<target>.gz with a .sha256 — the release
 *      assets. The host target's binary is also copied to ./gene for local use.
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
 * Build targets, `<process.platform>-<process.arch>`. `asset` is the release asset
 * name — keep in sync with ASSET_NAMES in src/update.ts and asset_name in install.sh.
 * `lib` is the OpenTUI native library's file name inside @opentui/core-<target>.
 */
const TARGETS = {
  "darwin-arm64": { nodeDist: "darwin-arm64", lib: "libopentui.dylib" },
  "linux-x64": { nodeDist: "linux-x64", lib: "libopentui.so" },
  "linux-arm64": { nodeDist: "linux-arm64", lib: "libopentui.so" },
};
const HOST = `${process.platform}-${process.arch}`;
const CACHE = p("node_modules", ".cache", "gene-build");

const parseTargets = () => {
  const i = process.argv.indexOf("--target");
  const eq = process.argv.find(a => a.startsWith("--target="));
  const raw = eq ? eq.slice("--target=".length) : i >= 0 ? process.argv[i + 1] : "all";
  if (!raw) {
    console.error("✗ --target needs a value: all, host, or a comma list of " + Object.keys(TARGETS).join(", "));
    process.exit(1);
  }
  const list = raw === "all" ? Object.keys(TARGETS) : raw.split(",").map(t => (t.trim() === "host" ? HOST : t.trim()));
  for (const t of list) {
    if (!TARGETS[t]) {
      console.error(`✗ unknown target "${t}" — expected all, host, or one of: ${Object.keys(TARGETS).join(", ")}`);
      process.exit(1);
    }
  }
  return [...new Set(list)];
};
const targets = parseTargets();

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
    // OpenTUI platform packages (never imported in the binary — see the note above)
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

// ---- per-target inputs -----------------------------------------------------------

const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * The Node binary to inject the SEA into. The host target uses the running node; any
 * other target gets the same Node version's official build, downloaded once, checked
 * against nodejs.org's SHASUMS256.txt, and cached.
 */
const nodeFor = async target => {
  if (target === HOST) return process.execPath;
  const name = `node-${process.version}-${TARGETS[target].nodeDist}`;
  const dir = path.join(CACHE, name);
  const bin = path.join(dir, "node");
  if (fs.existsSync(bin)) return bin;

  const base = `https://nodejs.org/dist/${process.version}`;
  console.log(`• downloading ${name}.tar.gz`);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = sums.split("\n").find(l => l.endsWith(`  ${name}.tar.gz`))?.split(/\s+/)[0];
  if (!want) throw new Error(`${name}.tar.gz is not listed in ${base}/SHASUMS256.txt`);
  const res = await fetch(`${base}/${name}.tar.gz`);
  if (!res.ok) throw new Error(`download ${name}.tar.gz: HTTP ${res.status}`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const got = sha256(tgz);
  if (got !== want) throw new Error(`${name}.tar.gz checksum mismatch (expected ${want}, got ${got})`);

  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, `${name}.tar.gz`);
  fs.writeFileSync(archive, tgz);
  execFileSync("tar", ["-xzf", archive, "-C", dir, "--strip-components=2", `${name}/bin/node`], { stdio: "inherit" });
  fs.rmSync(archive);
  return bin;
};

/**
 * The OpenTUI native library for a target: from node_modules when npm installed that
 * platform package (it installs only the host's), else `npm pack`ed at the exact
 * version @opentui/core pins and cached.
 */
const openTuiLibFor = target => {
  const pkg = `@opentui/core-${target}`;
  const { lib } = TARGETS[target];
  const installed = p("node_modules", pkg, lib);
  if (fs.existsSync(installed)) return installed;

  const version = JSON.parse(fs.readFileSync(p("node_modules", "@opentui", "core", "package.json"), "utf8")).version;
  const dir = path.join(CACHE, `opentui-core-${target}-${version}`);
  const cached = path.join(dir, lib);
  if (fs.existsSync(cached)) return cached;

  console.log(`• fetching ${pkg}@${version}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = execFileSync("npm", ["pack", `${pkg}@${version}`, "--pack-destination", dir, "--silent"], {
    encoding: "utf8",
    cwd: dir,
  })
    .trim()
    .split("\n")
    .pop();
  const tgz = path.join(dir, file);
  execFileSync("tar", ["-xzf", tgz, "-C", dir, "--strip-components=1", `package/${lib}`], { stdio: "inherit" });
  fs.rmSync(tgz);
  return cached;
};

// ---- signing (macOS target only) -------------------------------------------------

// Without GENE_CODESIGN_IDENTITY the macOS binary is signed ad-hoc (enough to run
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
if (signIdentity && process.platform !== "darwin" && targets.includes("darwin-arm64")) {
  console.error("✗ GENE_CODESIGN_IDENTITY needs a Mac (codesign + notarytool) — build the darwin-arm64 target there");
  process.exit(1);
}

const hasCommand = cmd => {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const signMac = bin => {
  if (process.platform !== "darwin") {
    // No codesign off a Mac. rcodesign (apple-codesign) writes an ad-hoc signature
    // from Linux; without it the binary ships unsigned and install.sh / `gene
    // --update` ad-hoc sign it on the Mac they install it on.
    if (hasCommand("rcodesign")) {
      execFileSync("rcodesign", ["sign", bin], { stdio: "inherit" });
      console.log("• ad-hoc signed with rcodesign");
    } else {
      console.warn("! darwin-arm64 binary is unsigned (no rcodesign on PATH) — install.sh / `gene --update` ad-hoc sign it on install");
    }
    return;
  }

  if (!signIdentity) {
    try {
      execFileSync("codesign", ["--sign", "-", "--force", bin], { stdio: "inherit" });
      console.log("• ad-hoc codesigned");
    } catch (err) {
      console.warn("! codesign failed (continuing):", err.message);
    }
    return;
  }

  console.log(`• codesigning as "${signIdentity}"`);
  execFileSync(
    "codesign",
    ["--force", "--options", "runtime", "--timestamp", "--entitlements", p("entitlements.plist"), "--sign", signIdentity, bin],
    { stdio: "inherit" }
  );
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", bin], { stdio: "inherit" });
  if (!notaryProfile) return;

  // notarytool takes a zip/dmg/pkg, not a bare Mach-O; the ticket can't be stapled
  // to a bare binary either, so Gatekeeper looks it up online on first launch.
  const zip = path.join(path.dirname(bin), "gene-notarize.zip");
  fs.rmSync(zip, { force: true });
  execFileSync("ditto", ["-c", "-k", "--keepParent", bin, zip]);
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
};

// ---- build each target -----------------------------------------------------------

const baseSea = JSON.parse(fs.readFileSync(p("sea.json"), "utf8"));
const built = [];

for (const target of targets) {
  console.log(`\n• [${target}] building single executable`);
  const outDir = p("dist", target);
  fs.mkdirSync(outDir, { recursive: true });
  const bin = path.join(outDir, "gene");

  // sea.json holds what every target shares; the output, the Node binary and the
  // OpenTUI native library (asset key `libopentui`, see src/index.ts) are per target.
  const seaConfig = path.join(outDir, "sea.json");
  fs.writeFileSync(
    seaConfig,
    JSON.stringify(
      {
        ...baseSea,
        output: path.relative(root, bin),
        executable: await nodeFor(target),
        assets: { ...baseSea.assets, libopentui: path.relative(root, openTuiLibFor(target)) },
      },
      null,
      2
    )
  );
  execFileSync(process.execPath, ["--build-sea", seaConfig], { stdio: "inherit", cwd: root });
  if (target.startsWith("darwin-")) signMac(bin);
  fs.chmodSync(bin, 0o755);

  // Package the release artifact: gzip the binary and write its sha256. This `.gz` is
  // what gets uploaded to the GitHub release; `gene --update` and install.sh download it
  // and decompress on install.
  const asset = `gene-${target}`;
  await pipeline(fs.createReadStream(bin), zlib.createGzip({ level: 9 }), fs.createWriteStream(p(`${asset}.gz`)));
  fs.writeFileSync(p(`${asset}.gz.sha256`), `${sha256(fs.readFileSync(p(`${asset}.gz`)))}  ${asset}.gz\n`);
  built.push(`${asset}.gz (${(fs.statSync(p(`${asset}.gz`)).size / 1e6).toFixed(1)} MB)`);

  if (target === HOST) {
    fs.copyFileSync(bin, p("gene"));
    fs.chmodSync(p("gene"), 0o755);
  }
}

// Leftover from before multi-target builds; never uploaded again.
for (const f of ["gene-macos-arm64.gz", "gene-macos-arm64.gz.sha256"]) fs.rmSync(p(f), { force: true });

console.log(`\n✓ done — ${built.join(", ")} + .sha256${targets.includes(HOST) ? "; ./gene is the " + HOST + " build" : ""}`);
