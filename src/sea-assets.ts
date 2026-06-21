/**
 * Helpers for the Single Executable Application (SEA) build.
 *
 * When `gene` runs as a standalone binary (`node --build-sea`), the things a normal
 * Node process reads from disk — the PGlite WASM payloads, the OpenTUI native
 * library, package.json — are instead embedded as SEA assets and reached through
 * `node:sea`. In development (plain `node src/index.ts`) `inSea()` is false and
 * callers fall back to their on-disk paths, so none of this is exercised.
 *
 * `node:sea` is a builtin and always importable; the asset accessors only work
 * inside a real SEA, so every call site guards on `inSea()` first.
 */

import { isSea, getRawAsset, getAssetAsBlob } from "node:sea";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Minimal ambient typing for the `WebAssembly` global we touch. The full types live
// in lib.dom.d.ts, which this Node-only project (lib: ["esnext"]) deliberately omits;
// PGlite's own .d.ts references WebAssembly.Module under skipLibCheck. An interface-only
// namespace emits no runtime value, so it merges cleanly with the global var.
declare global {
  namespace WebAssembly {
    interface Module {}
  }
  var WebAssembly: {
    Module: new (bytes: ArrayBuffer | ArrayBufferView) => WebAssembly.Module;
  };
}

/** True when running inside a built single executable. Never throws. */
export const inSea = (): boolean => {
  try {
    return isSea();
  } catch {
    return false;
  }
};

/** Compile an embedded `.wasm` asset into a WebAssembly.Module. */
export const wasmAsset = (key: string): WebAssembly.Module =>
  new WebAssembly.Module(getRawAsset(key));

/** Expose an embedded binary asset as a Blob (used for PGlite's fs bundle). */
export const blobAsset = (key: string): Blob => getAssetAsBlob(key);

/** Decode an embedded text asset (e.g. package.json) to a string. */
export const textAsset = (key: string): string =>
  new TextDecoder().decode(getRawAsset(key));

/**
 * Materialise an embedded binary asset to a file and return its path. Native
 * libraries (the OpenTUI dylib) must live on disk to be dlopen'd; we extract once
 * to a per-user temp dir and reuse it when the size already matches.
 */
export const extractAsset = (key: string, filename: string): string => {
  const dir = path.join(os.tmpdir(), "gene-sea");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, filename);

  const raw = getRawAsset(key); // ArrayBuffer
  const buf = Buffer.from(raw);

  let needWrite = true;
  try {
    if (fs.statSync(dest).size === buf.length) needWrite = false;
  } catch {
    // not present yet — write it
  }
  if (needWrite) fs.writeFileSync(dest, buf, { mode: 0o755 });
  return dest;
};

/**
 * Resolve the package version: from the embedded package.json asset in a SEA,
 * otherwise from package.json in the current working directory during development.
 */
export const readVersion = (): string => {
  if (inSea()) {
    try {
      return JSON.parse(textAsset("package.json")).version ?? "unknown";
    } catch {
      // fall through to disk
    }
  }
  try {
    const onDisk = path.join(process.cwd(), "package.json");
    return JSON.parse(fs.readFileSync(onDisk, "utf-8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
};
