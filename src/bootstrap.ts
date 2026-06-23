/**
 * Local configuration bootstrap. Loads up to two dotenv-style `KEY=VALUE` files into
 * `process.env` WITHOUT overriding any value already present — real environment
 * variables always win ("env first"). This is what lets a standalone `gene` binary,
 * dropped into a folder, pick up its settings with zero flags.
 *
 * Two files, both optional, looked up in the current working directory:
 *   - `.gene.config` — secrets and per-machine overrides (gitignored). Loaded FIRST so
 *     it wins over `gene.config` on any shared key — it overrides committed defaults,
 *     not just supplies secrets.
 *   - `gene.config`  — non-secret configuration, safe to commit.
 *
 * Resulting precedence (highest first): real env  >  .gene.config  >  gene.config.
 *
 * `GENE_CONFIG` relocates the `gene.config` path (absolute, or relative to the cwd);
 * the `.gene.config` secrets file is then looked up alongside it (same directory).
 *
 * Imported purely for its side effect, and as the FIRST import of both logger.ts and
 * config.ts — the two earliest-evaluated leaves — so the files are loaded before any
 * module reads `process.env`. ES modules are singletons, so this runs exactly once.
 *
 * Missing files are not an error: env-only configuration is fully supported (and is
 * how the dev flow works, via `node --env-file-if-exists=.env.development`).
 */

import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/** Non-secret config file (commit it) and the gitignored secrets / local-override file. */
const CONFIG_FILENAME = "gene.config";
const SECRETS_FILENAME = ".gene.config";

/**
 * Overlay parsed config layers onto a base environment, filling only keys the base
 * leaves unset (or blank), with EARLIER layers winning over later ones. Pure (touches
 * no `process.env`) so the precedence rule is unit-testable; the loader applies the
 * returned overlay. Returns only the keys to add — the base is left untouched.
 */
export const overlayEnv = (
  base: Record<string, string | undefined>,
  layers: Record<string, string>[]
): Record<string, string> => {
  const overlay: Record<string, string> = {};
  const alreadySet = (key: string): boolean => {
    const current = overlay[key] ?? base[key];
    return current !== undefined && current.trim() !== "";
  };
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (!alreadySet(key)) {
        overlay[key] = value;
      }
    }
  }
  return overlay;
};

/**
 * Read and dotenv-parse a config file. A missing file yields `{}`; it's only worth a
 * warning when the path was explicitly requested (an unreadable `GENE_CONFIG`). A
 * malformed file is skipped silently so a typo can't crash startup.
 */
const readConfigFile = (file: string, warnIfUnreadable: boolean): Record<string, string> => {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    if (warnIfUnreadable) {
      process.stderr.write(`[gene:config] GENE_CONFIG=${file} could not be read — using the environment only\n`);
    }
    return {};
  }
  try {
    // Node's built-in dotenv parser — same syntax as .env / --env-file.
    return parseEnv(text) as Record<string, string>;
  } catch {
    return {};
  }
};

const loadConfigFiles = (): void => {
  // GENE_CONFIG, if set, relocates the committed config file (absolute, or relative to
  // the cwd); otherwise it's `gene.config` in the cwd. The `.gene.config` secrets file
  // is looked up in the same directory.
  const override = process.env.GENE_CONFIG?.trim();
  const configFile = override ? path.resolve(override) : path.join(process.cwd(), CONFIG_FILENAME);
  const secretsFile = path.join(path.dirname(configFile), SECRETS_FILENAME);

  // Secrets / local overrides first so they win over committed config; real env (already
  // in process.env) still wins over both since overlayEnv only fills unset keys.
  const overlay = overlayEnv(process.env, [
    readConfigFile(secretsFile, false),
    readConfigFile(configFile, Boolean(override))
  ]);
  for (const [key, value] of Object.entries(overlay)) {
    process.env[key] = value;
  }
};

loadConfigFiles();
