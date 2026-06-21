/**
 * SEA build shim — replaces the `@opentui/core-darwin-arm64` platform package at
 * bundle time (via an esbuild `alias`).
 *
 * That package's real entry point resolves the dylib relative to `import.meta.url`,
 * which inside a single executable points at the `gene` binary itself — the wrong
 * place. Instead, index.ts extracts the embedded `libopentui.dylib` to a temp file
 * and assigns its path to `globalThis.__GENE_OPENTUI_DYLIB__` BEFORE the UI module
 * (and therefore @opentui/core, which reads this default during its top-level init)
 * is imported. `getOpenTUILib()` uses this as the dlopen target.
 *
 * This module only ever ends up in the SEA bundle; the dev flow uses the real
 * platform package, so the global is always set by the time this is read.
 */

const dylib = (globalThis as { __GENE_OPENTUI_DYLIB__?: string })
  .__GENE_OPENTUI_DYLIB__;

if (!dylib) {
  throw new Error(
    "gene: OpenTUI native library path was not initialised before the UI loaded",
  );
}

export default dylib;
