/**
 * One-shot CLI to manage the Trello board webhook.
 *
 *   npm run webhook                 # register against GENE_WEBHOOK_URL (idempotent), then list
 *   npm run webhook -- --list       # just list webhooks on this token/board
 *   npm run webhook -- --delete-all # delete every webhook on this board
 *
 * Requires GENE_TRACKER=trello, TRELLO_BOARD, TRELLO_API_KEY, TRELLO_TOKEN; the
 * register path additionally needs GENE_WEBHOOK_URL (your public tunnel URL).
 */

import logger from "./logger.ts";
import { env } from "./config.ts";
import { listTrelloWebhooks, ensureTrelloWebhook, deleteTrelloWebhook } from "./tracker/trello/webhook.ts";

const main = async (): Promise<void> => {
  if (env.TRACKER !== "trello") {
    logger.error("[webhook] only the Trello tracker supports webhooks (set GENE_TRACKER=trello)");
    process.exit(1);
  }
  if (!env.TRELLO_BOARD) {
    logger.error("[webhook] TRELLO_BOARD is required");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const existing = await listTrelloWebhooks();
  const onBoard = existing.filter(w => w.idModel === env.TRELLO_BOARD);
  logger.info(`[webhook] ${existing.length} webhook(s) on token; ${onBoard.length} on board ${env.TRELLO_BOARD}`);
  for (const w of onBoard) {
    logger.info(`[webhook]   - ${w.id} → ${w.callbackURL} (active=${w.active})`);
  }

  if (args.includes("--list")) {
    return;
  }
  if (args.includes("--delete-all")) {
    for (const w of onBoard) {
      logger.info(`[webhook] deleting ${w.id}…`);
      await deleteTrelloWebhook(w.id);
    }
    return;
  }
  if (!env.WEBHOOK_URL) {
    logger.error("[webhook] GENE_WEBHOOK_URL is required to register (start a tunnel, e.g. cloudflared)");
    process.exit(1);
  }
  await ensureTrelloWebhook(env.TRELLO_BOARD, env.WEBHOOK_URL);
};

main().catch(error => {
  logger.error("[webhook] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
