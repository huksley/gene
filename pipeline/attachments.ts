/**
 * Stage Trello card attachments (currently: images) into the agent's worktree
 * so the agent can `Read` them and use Claude's vision to interpret them.
 *
 * Files land at `<worktree>/.trello-attachments/<filename>` and are gitignored
 * (via the meridian repo's top-level `.gitignore`).
 *
 * - We restrict to image MIME types — the agent doesn't need the rest yet.
 * - Filenames are sanitized to avoid path traversal.
 * - Existing files are kept (idempotent across resume runs).
 */

import { mkdir, writeFile, stat } from "fs/promises";
import path from "path";
import logger from "@/lib/logger";
import { downloadAttachment, getCardAttachments, type TrelloAttachment } from "./trello";

const IMAGE_MIME_PREFIX = "image/";
const ATTACHMENTS_DIRNAME = ".trello-attachments";

export type StagedAttachment = {
  attachment: TrelloAttachment;
  localPath: string;
  relativePath: string;
};

const sanitizeFileName = (raw: string, fallback: string): string => {
  const trimmed = (raw || fallback).replace(/[/\\]/g, "_").replace(/^\.+/, "");
  return trimmed.length > 0 ? trimmed : fallback;
};

const isImage = (attachment: TrelloAttachment): boolean => {
  if (attachment.mimeType?.startsWith(IMAGE_MIME_PREFIX)) {
    return true;
  }
  const name = (attachment.fileName ?? attachment.name ?? attachment.url ?? "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg)(\?|$)/.test(name);
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

export const stageCardAttachments = async (
  cardId: string,
  worktreePath: string
): Promise<StagedAttachment[]> => {
  const attachments = await getCardAttachments(cardId);
  const images = attachments.filter(isImage);
  if (images.length === 0) {
    return [];
  }

  const destDir = path.join(worktreePath, ATTACHMENTS_DIRNAME);
  await mkdir(destDir, { recursive: true });

  const staged: StagedAttachment[] = [];
  for (const attachment of images) {
    const fileName = sanitizeFileName(
      attachment.fileName ?? attachment.name ?? "attachment",
      `attachment-${attachment.id}`
    );
    const localPath = path.join(destDir, fileName);
    const relativePath = path.join(ATTACHMENTS_DIRNAME, fileName);

    if (await fileExists(localPath)) {
      logger.info(`[ai-pipeline] attachment cached: ${relativePath}`);
      staged.push({ attachment, localPath, relativePath });
      continue;
    }

    try {
      const data = await downloadAttachment(cardId, attachment.id, fileName);
      await writeFile(localPath, data);
      logger.info(
        `[ai-pipeline] downloaded attachment: ${relativePath} (${data.length} bytes)`
      );
      staged.push({ attachment, localPath, relativePath });
    } catch (error) {
      logger.warn(
        `[ai-pipeline] failed to download attachment ${attachment.id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return staged;
};
