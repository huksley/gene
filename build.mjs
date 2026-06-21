/**
 * Build the standalone `gene` executable (macOS arm64).
 *
 *   1. esbuild bundles src/index.ts and its whole import graph into a single ESM
 *      file (dist/gene.js). String-literal dynamic imports of local modules
 *      (./ui/app.ts, ./import-legacy.ts) and of @electric-sql/pglite are inlined.
 *   2. `node --build-sea sea.json` wraps that bundle — plus the embedded assets
 *      (PGlite WASM, the OpenTUI dylib, package.json) — into ./gene.
 *   3. On macOS the result is re-signed ad-hoc so it will run.
 *
 * Notes on the externals/alias below:
 *   - The non-darwin-arm64 OpenTUI platform packages are referenced by string
 *     dynamic import inside @opentui/core but are not installed; mark them external
 *     so esbuild leaves them as runtime imports (the darwin-arm64 branch is the only
 *     one that ever executes here).
 *   - @opentui/core-darwin-arm64 is aliased to our shim so the dylib path resolves
 *     to the extracted asset rather than to a location next to the binary.
 *   - pg's optional native/edge deps are external (never loaded in this config).
 */

import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));
const p = (...s) => path.join(root, ...s);
const shim = p("src", "shims", "opentui-native.ts");

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
  alias: { "@opentui/core-darwin-arm64": shim },
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

if (process.platform === "darwin") {
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
console.log("✓ done — ./gene");
