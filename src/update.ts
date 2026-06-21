/**
 * `gene --update` — replace the running standalone binary with the latest GitHub
 * release, in place.
 *
 * Only meaningful for the single executable (`inSea()`): there is a real file at
 * `process.execPath` to swap. In a dev checkout `process.execPath` is `node`, so we
 * refuse and point at `git pull` instead. macOS arm64 is the only published target.
 *
 * Published assets are gzipped (`gene-macos-arm64.gz`) and decompressed on the fly as
 * they download. The swap is careful: stream into a sibling temp file (same dir →
 * atomic rename), make it executable + ad-hoc signed, stash the current binary as
 * `<bin>.old`, move the new one into place, then verify it runs `--version`; on any
 * failure the old binary is restored. Replacing the file a process is currently
 * executing is safe on Unix — the running image keeps the old inode until it exits.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import logger from "./logger.ts";
import { inSea, readVersion } from "./sea-assets.ts";

/** GitHub repo that publishes gene releases. */
const OWNER = "huksley";
const REPO = "gene";

/**
 * Release assets to try, in priority order. Published assets are gzipped (`.gz`) and
 * decompressed while downloading; the plain-binary names are kept as a fallback for
 * older releases. Keep in sync with install.sh's ASSET_CANDIDATES.
 */
const ASSET_CANDIDATES: { name: string; gzip: boolean }[] = [
  { name: "gene-darwin-arm64.gz", gzip: true },
  { name: "gene-macos-arm64.gz", gzip: true },
  { name: "gene.gz", gzip: true },
  { name: "gene-darwin-arm64", gzip: false },
  { name: "gene-macos-arm64", gzip: false },
  { name: "gene", gzip: false }
];

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
interface Release {
  tag_name: string;
  html_url: string;
  assets?: ReleaseAsset[];
}

/** Options for {@link selfUpdate}. */
export interface UpdateOptions {
  /** Reinstall even when the latest release is not newer than the running build. */
  force?: boolean;
}

/** A GitHub token from the environment lifts the unauthenticated API rate limit. */
const ghToken = (): string =>
  (process.env.GENE_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();

const ghHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    "User-Agent": `gene-updater/${readVersion()}`,
    Accept: "application/vnd.github+json"
  };
  const token = ghToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

/** Compare dotted versions; <0 when a<b, 0 when equal, >0 when a>b. Non-numeric parts count as 0. */
const compareVersions = (a: string, b: string): number => {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map(n => Number.parseInt(n, 10))
      .map(n => (Number.isFinite(n) ? n : 0));
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
};

const safeUnlink = (file: string): void => {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
};

const isPermissionError = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
};

/**
 * Download and install the latest release over the running binary. Returns true on a
 * successful update or when already current; false on any failure (the caller maps
 * that to a non-zero exit). Never throws — failures are logged and swallowed.
 */
export const selfUpdate = async (options: UpdateOptions = {}): Promise<boolean> => {
  const tag = logger.tag.update;

  if (!inSea()) {
    logger.error(
      `${tag} self-update only applies to the standalone binary. In a dev checkout, run \`git pull && npm run build\`.`
    );
    return false;
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    logger.error(`${tag} prebuilt releases are macOS arm64 only (this is ${process.platform}/${process.arch}).`);
    return false;
  }

  let target: string;
  try {
    target = fs.realpathSync(process.execPath); // follow a PATH symlink to the real file we replace
  } catch {
    target = process.execPath;
  }
  const current = readVersion();
  logger.info(`${tag} current version ${current} — checking ${OWNER}/${REPO} for the latest release…`);

  // 1. Resolve the latest release via the GitHub API.
  let release: Release;
  try {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, { headers: ghHeaders() });
    if (!res.ok) {
      const hint =
        res.status === 404
          ? " (no published releases yet?)"
          : res.status === 403
            ? " (rate limited — set GH_TOKEN)"
            : "";
      throw new Error(`GitHub API ${res.status} ${res.statusText}${hint}`);
    }
    release = (await res.json()) as Release;
  } catch (error) {
    logger.error(`${tag} could not fetch the latest release:`, error instanceof Error ? error.message : error);
    return false;
  }

  const latest = (release.tag_name ?? "").replace(/^v/i, "") || "unknown";

  // 2. Decide whether to update.
  const cmp = compareVersions(latest, current);
  if (cmp <= 0 && !options.force) {
    logger.info(`${tag} already on the latest version (${current}). Use \`gene --update --force\` to reinstall.`);
    return true;
  }
  if (cmp < 0 && options.force) {
    logger.warn(`${tag} release ${latest} is older than the running ${current} — reinstalling anyway (--force).`);
  }

  // 3. Pick a matching asset, carrying whether it needs decompressing.
  const asset = ASSET_CANDIDATES.map(c => {
    const found = release.assets?.find(a => a.name === c.name);
    return found ? { ...found, gzip: c.gzip } : undefined;
  }).find(Boolean);
  if (!asset) {
    const have = (release.assets ?? []).map(a => a.name).join(", ") || "none";
    logger.error(
      `${tag} release ${latest} has no macOS arm64 asset (looked for ${ASSET_CANDIDATES.map(c => c.name).join("/")}; found: ${have}).`
    );
    return false;
  }

  // 4. Stream the download to a sibling temp file (same dir → atomic rename later).
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.gene.update.${process.pid}`);
  logger.info(
    `${tag} downloading ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB${asset.gzip ? " gzipped" : ""}) for ${latest}…`
  );
  try {
    const res = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": ghHeaders()["User-Agent"] },
      redirect: "follow"
    });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    const dest = fs.createWriteStream(tmp, { mode: 0o755 });
    // gunzip on the fly for a `.gz` asset. The gzip trailer carries a CRC32 + length,
    // so a truncated or corrupt download throws here rather than installing garbage.
    await (asset.gzip ? pipeline(source, zlib.createGunzip(), dest) : pipeline(source, dest));
  } catch (error) {
    safeUnlink(tmp);
    logger.error(`${tag} download failed:`, error instanceof Error ? error.message : error);
    if (isPermissionError(error)) {
      logger.error(`${tag} ${dir} is not writable — re-run with more permissions (e.g. \`sudo gene --update\`).`);
    }
    return false;
  }

  // 5. Sanity-check the size, then make it runnable.
  const backup = `${target}.old`;
  try {
    const size = fs.statSync(tmp).size;
    if (size === 0) {
      throw new Error("downloaded file is empty");
    }
    // For a plain asset, asset.size is the on-disk size and must match exactly. For a
    // gzipped asset, asset.size is the *compressed* size — gunzip already verified
    // integrity above — so we only guard against an empty result.
    if (!asset.gzip && asset.size && size !== asset.size) {
      throw new Error(`size mismatch (got ${size}, expected ${asset.size}) — download truncated`);
    }
    fs.chmodSync(tmp, 0o755);
    if (process.platform === "darwin") {
      // Ad-hoc codesign (matches the build) and clear any quarantine flag so Gatekeeper
      // allows the freshly written binary. Both are best-effort: the released asset is
      // already signed, and a fetch download is not quarantined.
      try {
        execFileSync("codesign", ["--sign", "-", "--force", tmp], { stdio: "ignore" });
      } catch {
        /* already signed, or codesign unavailable */
      }
      try {
        execFileSync("xattr", ["-d", "com.apple.quarantine", tmp], { stdio: "ignore" });
      } catch {
        /* not quarantined */
      }
    }
  } catch (error) {
    safeUnlink(tmp);
    logger.error(`${tag} could not prepare the update:`, error instanceof Error ? error.message : error);
    return false;
  }

  // 6. Stash the current binary, swap the new one in (rolling back the move on failure).
  try {
    fs.renameSync(target, backup);
    try {
      fs.renameSync(tmp, target);
    } catch (swapError) {
      fs.renameSync(backup, target); // put the old binary back
      throw swapError;
    }
  } catch (error) {
    safeUnlink(tmp);
    logger.error(`${tag} could not install the update:`, error instanceof Error ? error.message : error);
    if (isPermissionError(error)) {
      logger.error(`${tag} ${target} is not writable — re-run with more permissions (e.g. \`sudo gene --update\`).`);
    }
    return false;
  }

  // 7. Verify the freshly installed binary actually runs; restore the old one if not.
  try {
    execFileSync(target, ["--version"], { stdio: "ignore" });
  } catch {
    try {
      fs.renameSync(backup, target);
    } catch {
      /* best-effort restore */
    }
    logger.error(`${tag} the downloaded binary failed to run — restored the previous version (${current}).`);
    return false;
  }

  safeUnlink(backup);
  logger.info(`${tag} ✓ updated ${current} → ${latest}. Restart gene to run the new version.`);
  if (release.html_url) {
    logger.info(`${tag} release notes: ${release.html_url}`);
  }
  return true;
};
