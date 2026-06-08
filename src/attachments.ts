/**
 * Stage image attachments referenced by a Linear issue into the agent's worktree
 * so the agent can `Read` them and use Claude's vision to interpret them.
 *
 * Linear embeds uploaded files as `https://uploads.linear.app/...` URLs inside
 * the issue description and comment markdown (there's no tidy attachments API).
 * We scrape those URLs, keep the image ones, and download them with the Linear
 * token (uploads.linear.app requires an Authorization header).
 *
 * Files land at `<worktree>/.gene-attachments/<filename>`. This whole step is
 * **best-effort**: any failure (no token, 401, network) is logged and skipped —
 * the URLs still appear verbatim in the prompt transcript, so the agent retains
 * the context even when the binary can't be staged.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import logger from "./logger.ts";
import { env } from "./config.ts";
import { run } from "./exec.ts";
import { fetchRetryTimeout } from "./fetch.ts";
import type { LinearComment, LinearIssue } from "./linear.ts";

const ATTACHMENTS_DIRNAME = ".gene-attachments";
const UPLOAD_URL_PATTERN = /https:\/\/uploads\.linear\.app\/[^\s)\]"'<>]+/g;
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg)(\?|#|$)/i;

export type StagedAttachment = {
  url: string;
  localPath: string;
  relativePath: string;
};

const sanitizeFileName = (raw: string, fallback: string): string => {
  const trimmed = (raw || fallback).replace(/[/\\]/g, "_").replace(/^\.+/, "");
  return trimmed.length > 0 ? trimmed : fallback;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

/** Collect distinct uploads.linear.app image URLs from the issue + comment bodies. */
const collectImageUrls = (issue: LinearIssue, comments: LinearComment[]): string[] => {
  const haystack = [issue.description, ...comments.map(c => c.body)].join("\n");
  const seen = new Set<string>();
  for (const match of haystack.matchAll(UPLOAD_URL_PATTERN)) {
    const url = match[0];
    if (IMAGE_EXT_PATTERN.test(url)) {
      seen.add(url);
    }
  }
  return [...seen];
};

const fileNameFromUrl = (url: string, index: number): string => {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const base = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  return sanitizeFileName(decodeURIComponent(base), `attachment-${index}`);
};

/** The token uploads.linear.app authenticates with: env first, else the CLI's stored token. */
const resolveLinearToken = async (): Promise<string | undefined> => {
  if (env.LINEAR_API_KEY) {
    return env.LINEAR_API_KEY;
  }
  // Best-effort: ask the CLI for its token. Tolerate the command not existing.
  const result = await run("linear", ["auth", "token"]);
  const token = result.stdout.trim();
  return result.code === 0 && token ? token : undefined;
};

/** Personal API keys go in the header raw; OAuth access tokens use the Bearer scheme. */
const authHeaders = (token: string): Array<Record<string, string>> => {
  const raw = { Authorization: token };
  const bearer = { Authorization: `Bearer ${token}` };
  return token.startsWith("lin_api_") ? [raw, bearer] : [bearer, raw];
};

const download = async (url: string, token: string): Promise<Buffer | null> => {
  for (const headers of authHeaders(token)) {
    try {
      // Retry transient drops/timeouts/5xx; a 401/403 comes back as-is so we can
      // fall through to the next auth scheme below.
      const res = await fetchRetryTimeout(url, { headers });
      if (res.ok) {
        return Buffer.from(await res.arrayBuffer());
      }
      if (res.status !== 401 && res.status !== 403) {
        logger.warn(`[gene] attachment ${url} → HTTP ${res.status}`);
        return null;
      }
    } catch (error) {
      logger.warn(`[gene] attachment ${url} fetch failed:`, error instanceof Error ? error.message : error);
      return null;
    }
  }
  logger.warn(`[gene] attachment ${url} → unauthorized (token rejected)`);
  return null;
};

export const stageIssueAttachments = async (
  issue: LinearIssue,
  comments: LinearComment[],
  worktreePath: string
): Promise<StagedAttachment[]> => {
  const urls = collectImageUrls(issue, comments);
  if (urls.length === 0) {
    return [];
  }

  const destDir = path.join(worktreePath, ATTACHMENTS_DIRNAME);
  await mkdir(destDir, { recursive: true });

  const staged: StagedAttachment[] = [];
  let token: string | undefined;

  for (const [index, url] of urls.entries()) {
    const fileName = fileNameFromUrl(url, index);
    const localPath = path.join(destDir, fileName);
    const relativePath = path.join(ATTACHMENTS_DIRNAME, fileName);

    if (await fileExists(localPath)) {
      logger.info(`[gene] attachment cached: ${relativePath}`);
      staged.push({ url, localPath, relativePath });
      continue;
    }

    if (token === undefined) {
      token = await resolveLinearToken();
      if (!token) {
        logger.warn(
          `[gene] ${urls.length} attachment(s) referenced but no Linear token available — ` +
            "skipping downloads (URLs remain in the prompt transcript)"
        );
        return staged;
      }
    }

    const data = await download(url, token);
    if (!data) {
      continue;
    }
    await writeFile(localPath, data);
    logger.info(`[gene] downloaded attachment: ${relativePath} (${data.length} bytes)`);
    staged.push({ url, localPath, relativePath });
  }

  return staged;
};
