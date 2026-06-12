/**
 * Trello webhook resource for the Trello tracker. Kept separate from trello.ts so
 * that file stays focused on the issue/state mapping. Two concerns:
 *
 *  - **Registration** (REST): list/create/delete the board webhook against a public
 *    callback URL (a tunnel). Shared by `TrelloTracker.startWatch` and the
 *    `npm run webhook` CLI.
 *  - **Listening**: a tiny node:http server that verifies Trello's HMAC-SHA1
 *    signature, filters to card activity, and calls `onActivity` to wake the daemon.
 *
 * `verifyTrelloSignature` / `isRelevantTrelloAction` are pure and unit-tested.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import crypto from "node:crypto";
import logger from "../../logger.ts";
import { env } from "../../config.ts";
import { fetchRetryTimeout } from "../../fetch.ts";

const API_BASE = "https://api.trello.com/1";

/** Trello action types worth waking the daemon for (card-scoped activity). */
const RELEVANT_ACTIONS = new Set([
  "commentCard",
  "updateCard",
  "createCard",
  "addMemberToCard",
  "removeMemberFromCard"
]);

/** True when a Trello action type is one we want to react to. */
export const isRelevantTrelloAction = (type: string): boolean => RELEVANT_ACTIONS.has(type);

/** Verify Trello's webhook signature: base64(HMAC-SHA1(body + callbackURL, secret)). */
export const verifyTrelloSignature = (
  body: string,
  callbackUrl: string,
  signature: string,
  secret: string
): boolean => {
  const expected = crypto.createHmac("sha1", secret).update(body + callbackUrl).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    // timingSafeEqual throws on length mismatch — treat as invalid.
    return false;
  }
};

const auth = (): string => `key=${env.TRELLO_API_KEY}&token=${env.TRELLO_TOKEN}`;

export type TrelloWebhook = {
  id: string;
  description: string;
  idModel: string;
  callbackURL: string;
  active: boolean;
};

/** All webhooks registered against the current Trello token. */
export const listTrelloWebhooks = async (): Promise<TrelloWebhook[]> => {
  const res = await fetchRetryTimeout(`${API_BASE}/tokens/${env.TRELLO_TOKEN}/webhooks?${auth()}`);
  if (!res.ok) {
    throw new Error(`Trello list webhooks -> ${res.status}`);
  }
  return (await res.json()) as TrelloWebhook[];
};

export const createTrelloWebhook = async (idModel: string, callbackURL: string): Promise<TrelloWebhook> => {
  const res = await fetchRetryTimeout(`${API_BASE}/webhooks/?${auth()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idModel, callbackURL, description: "Gene AI pipeline (auto-registered)" })
  });
  if (!res.ok) {
    throw new Error(`Trello create webhook -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TrelloWebhook;
};

export const deleteTrelloWebhook = async (id: string): Promise<void> => {
  const res = await fetchRetryTimeout(`${API_BASE}/webhooks/${id}?${auth()}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`Trello delete webhook ${id} -> ${res.status}`);
  }
};

/** Register the board webhook against `callbackUrl` if not already present (idempotent). */
export const ensureTrelloWebhook = async (idModel: string, callbackUrl: string): Promise<void> => {
  const existing = await listTrelloWebhooks();
  if (existing.some(w => w.idModel === idModel && w.callbackURL === callbackUrl)) {
    logger.info(`[trello-webhook] already registered → ${callbackUrl}`);
    return;
  }
  const created = await createTrelloWebhook(idModel, callbackUrl);
  logger.info(`[trello-webhook] registered (id=${created.id}, active=${created.active}) → ${callbackUrl}`);
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });

/**
 * Start the webhook HTTP listener. HEAD → 200 (Trello verifies the URL on
 * registration); POST → verify signature, filter the action, call `onActivity`.
 * Returns a stop function that closes the server.
 */
export const startTrelloWebhookListener = (opts: {
  port: number;
  callbackUrl: string;
  secret: string;
  onActivity: () => void;
}): (() => void) => {
  const server: Server = createServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    void readBody(req)
      .then(body => {
        const signature = String(req.headers["x-trello-webhook"] ?? "");
        if (!verifyTrelloSignature(body, opts.callbackUrl, signature, opts.secret)) {
          logger.warn("[trello-webhook] signature verification failed");
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200).end();
        try {
          const parsed = JSON.parse(body) as { action?: { type?: string } };
          const type = parsed.action?.type ?? "";
          if (isRelevantTrelloAction(type)) {
            logger.info(`[trello-webhook] ${type} — waking poll loop`);
            opts.onActivity();
          }
        } catch {
          /* malformed body — already 200'd, nothing to wake on */
        }
      })
      .catch(() => {
        res.writeHead(400).end();
      });
  });
  server.on("error", error =>
    logger.error("[trello-webhook] listener error:", error instanceof Error ? error.message : error)
  );
  server.listen(opts.port, () => logger.info(`[trello-webhook] listening on :${opts.port}`));
  return () => {
    try {
      server.close();
    } catch {
      /* already closed */
    }
  };
};
