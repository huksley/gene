/**
 * One-shot CLI: registers a Trello webhook against the configured tunnel URL.
 *
 * Usage:
 *   # Make sure AI_PIPELINE_TUNNEL_URL is set in .env.local and the Next dev
 *   # server is reachable from that URL (cloudflared tunnel running).
 *   npm run pipeline:webhook-setup           # list + register if missing
 *   npm run pipeline:webhook-setup -- --list # just list existing webhooks
 *   npm run pipeline:webhook-setup -- --delete-all  # remove all existing webhooks for this board
 *
 * Trello will HEAD the callbackURL before registering. The Next dev server must
 * be running and the webhook endpoint reachable through the tunnel.
 */

import logger from "@/lib/logger";
import { env } from "./config";

const API_BASE = "https://api.trello.com/1";

type Webhook = {
  id: string;
  description: string;
  idModel: string;
  callbackURL: string;
  active: boolean;
};

const auth = (): string => `key=${env.TRELLO_API_KEY}&token=${env.TRELLO_TOKEN}`;

const callbackUrlFor = (tunnelUrl: string): string =>
  `${tunnelUrl.replace(/\/$/, "")}/api/ai-pipeline/trello-webhook`;

const listWebhooks = async (): Promise<Webhook[]> => {
  const res = await fetch(`${API_BASE}/tokens/${env.TRELLO_TOKEN}/webhooks?${auth()}`);
  if (!res.ok) {
    throw new Error(`listWebhooks failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Webhook[]>;
};

const deleteWebhook = async (id: string): Promise<void> => {
  const res = await fetch(`${API_BASE}/webhooks/${id}?${auth()}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`deleteWebhook ${id} failed: ${res.status} ${await res.text()}`);
  }
};

const createWebhook = async (callbackURL: string): Promise<Webhook> => {
  const res = await fetch(`${API_BASE}/webhooks/?${auth()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idModel: env.AI_PIPELINE_BOARD_ID,
      description: "AI Code Assistant pipeline (auto-registered)",
      callbackURL
    })
  });
  if (!res.ok) {
    throw new Error(`createWebhook failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Webhook>;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const deleteAll = args.includes("--delete-all");

  if (!env.AI_PIPELINE_TUNNEL_URL && !listOnly && !deleteAll) {
    logger.error("[setup-webhook] AI_PIPELINE_TUNNEL_URL is required. Start a tunnel:");
    logger.error("[setup-webhook]   cloudflared tunnel --url http://localhost:3000");
    logger.error(
      "[setup-webhook] then set AI_PIPELINE_TUNNEL_URL in .env.local to the printed URL."
    );
    process.exit(1);
  }

  const existing = await listWebhooks();
  const onBoard = existing.filter(webhook => webhook.idModel === env.AI_PIPELINE_BOARD_ID);
  logger.info(
    `[setup-webhook] ${existing.length} webhook(s) on this token; ${onBoard.length} target board ${env.AI_PIPELINE_BOARD_ID}`
  );
  for (const webhook of onBoard) {
    logger.info(
      `[setup-webhook]   - ${webhook.id} → ${webhook.callbackURL} (active=${webhook.active})`
    );
  }

  if (deleteAll) {
    for (const webhook of onBoard) {
      logger.info(`[setup-webhook] deleting ${webhook.id}…`);
      await deleteWebhook(webhook.id);
    }
    logger.info("[setup-webhook] done.");
    return;
  }

  if (listOnly) {
    return;
  }

  const callbackURL = callbackUrlFor(env.AI_PIPELINE_TUNNEL_URL as string);
  const alreadyHere = onBoard.find(webhook => webhook.callbackURL === callbackURL);
  if (alreadyHere) {
    logger.info(
      `[setup-webhook] already registered (id=${alreadyHere.id}, active=${alreadyHere.active}) — nothing to do.`
    );
    return;
  }

  logger.info(`[setup-webhook] registering webhook → ${callbackURL}`);
  const created = await createWebhook(callbackURL);
  logger.info(`[setup-webhook] registered (id=${created.id}, active=${created.active})`);
  logger.info(
    "[setup-webhook] note: Trello HEADed the callback to verify; if you got an error, ensure `npm run dev` is up and the tunnel is reachable."
  );
};

main().catch(error => {
  logger.error("[setup-webhook] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
