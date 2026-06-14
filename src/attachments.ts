/**
 * Stage attachments referenced by an issue into the agent's worktree so the agent
 * can `Read` them — images (interpreted via Claude's vision) and text/doc files
 * (markdown, txt, csv, json, yaml, log) read as text.
 *
 * The active tracker knows where its files live and how to authenticate for them:
 * it scrapes the referenced URLs (`tracker.collectAttachmentUrls`) and downloads
 * each one (`tracker.fetchAttachment`). This module is tracker-agnostic — it just
 * caches the bytes under the worktree and names the files.
 *
 * Files land at `<worktree>/.gene-attachments/<filename>`. This whole step is
 * **best-effort**: any failure (no token, 401, network) is logged and skipped —
 * the URLs still appear verbatim in the prompt transcript, so the agent retains
 * the context even when the binary can't be staged.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import logger from "./logger.ts";
import { tracker } from "./tracker/index.ts";
import type { Comment, Issue } from "./tracker/index.ts";

const ATTACHMENTS_DIRNAME = ".gene-attachments";

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

const fileNameFromUrl = (url: string, index: number): string => {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const base = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  return sanitizeFileName(decodeURIComponent(base), `attachment-${index}`);
};

export const stageIssueAttachments = async (
  issue: Issue,
  comments: Comment[],
  worktreePath: string
): Promise<StagedAttachment[]> => {
  const refs = await tracker.collectAttachmentUrls(issue, comments);
  if (refs.length === 0) {
    return [];
  }

  const destDir = path.join(worktreePath, ATTACHMENTS_DIRNAME);
  await mkdir(destDir, { recursive: true });

  const staged: StagedAttachment[] = [];

  for (const [index, { url, fileName: suggested }] of refs.entries()) {
    // Prefer the filename the tracker recovered from the markdown label / metadata
    // (upload URLs are often extension-less UUIDs); fall back to the URL's last segment.
    const fileName = suggested
      ? sanitizeFileName(decodeURIComponent(suggested), `attachment-${index}`)
      : fileNameFromUrl(url, index);
    const localPath = path.join(destDir, fileName);
    const relativePath = path.join(ATTACHMENTS_DIRNAME, fileName);

    if (await fileExists(localPath)) {
      logger.info(`${logger.tag.tracker} attachment cached: ${relativePath}`);
      staged.push({ url, localPath, relativePath });
      continue;
    }

    const data = await tracker.fetchAttachment(url);
    if (!data) {
      continue;
    }
    await writeFile(localPath, data);
    logger.info(`${logger.tag.tracker} downloaded attachment: ${relativePath} (${data.length} bytes)`);
    staged.push({ url, localPath, relativePath });
  }

  return staged;
};
