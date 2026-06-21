/**
 * Local configuration bootstrap. Loads a `gene.config` file (dotenv `KEY=VALUE`
 * syntax) into `process.env`, WITHOUT overriding any value already present — real
 * environment variables win over the file ("env first"). This is what lets a
 * standalone `gene` binary, dropped into a folder next to a `gene.config`, pick up
 * its settings with zero flags.
 *
 * The file is `gene.config` in the current working directory by default; set
 * `GENE_CONFIG` to load a specific file instead (absolute, or relative to the cwd).
 *
 * Imported purely for its side effect, and as the FIRST import of both logger.ts
 * and config.ts — the two earliest-evaluated leaves — so the file is loaded before
 * any module reads `process.env`. ES modules are singletons, so the load below runs
 * exactly once no matter how many places import this.
 *
 * A missing gene.config is not an error: env-only configuration is fully supported
 * (and is how the dev flow works, via `node --env-file-if-exists=.env.development`).
 */

import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/** The config file name, resolved against the current working directory. */
const CONFIG_FILENAME = "gene.config";

const loadConfigFile = (): void => {
  // GENE_CONFIG, if set, names the file to load (absolute, or relative to the cwd);
  // otherwise fall back to `gene.config` in the current working directory.
  const override = process.env.GENE_CONFIG?.trim();
  const file = override ? path.resolve(override) : path.join(process.cwd(), CONFIG_FILENAME);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    // An explicit GENE_CONFIG that can't be read is worth a warning; the default
    // file being absent is normal (env-only configuration is fully supported).
    if (override) {
      process.stderr.write(`[gene:config] GENE_CONFIG=${file} could not be read — using the environment only\n`);
    }
    return;
  }

  let parsed: Record<string, string>;
  try {
    // Node's built-in dotenv parser — same syntax as .env / --env-file.
    parsed = parseEnv(text) as Record<string, string>;
  } catch {
    return; // malformed file — fall back to the environment rather than crash
  }

  for (const [key, value] of Object.entries(parsed)) {
    // Env first: only fill keys the environment hasn't already set.
    const existing = process.env[key];
    if (existing === undefined || existing.trim() === "") {
      process.env[key] = value;
    }
  }
};

loadConfigFile();
