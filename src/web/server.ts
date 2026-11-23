/**
 * The web UI server: a read-only overview of the daemon's tickets, programs and recent
 * runs, on GENE_UI_HOSTNAME / GENE_UI_PORT (or UI_HOSTNAME / UI_PORT).
 *
 *   GET /               the page (one self-contained HTML file, see web/vite.config.ts)
 *   GET /api/overview   {@link Overview} JSON; `?days=N` sets the run window (default 7)
 *   GET /api/health     `{ ok: true, auth: boolean }` — never needs the token
 *
 * With GENE_UI_TOKEN / UI_TOKEN set, /api/overview needs `Authorization: Bearer <token>`.
 * The page itself is served without it (it holds no data): it asks for the token once
 * and keeps it in localStorage. Without a token anyone who can reach the port can read
 * the overview — keep the default 127.0.0.1 bind, or set a token before binding wider.
 *
 * Read-only by design: nothing here writes to the tracker, the forge or the store.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { env } from "../config.ts";
import logger from "../logger.ts";
import { inSea, textAsset } from "../sea-assets.ts";
import { buildOverview, MAX_WINDOW_DAYS } from "./overview.ts";

const DEFAULT_WINDOW_DAYS = 7;

/**
 * An optional extension of the web UI: GET routes under /api/ (behind the same token)
 * whose JSON a matching tab in the page renders. The page learns which addons are on
 * from `Overview.addons`.
 */
export type WebAddon = {
  name: string;
  routes: Record<string, (url: URL) => Promise<unknown>>;
};

const MISSING_UI = `<!doctype html><meta charset="utf-8"><title>Gene</title>
<body style="font:14px system-ui;padding:2rem">
<p>The web UI isn't built. Run <code>pnpm build:ui</code> and reload — the API is up at
<a href="/api/overview">/api/overview</a>.</p></body>`;

/** The page: the embedded asset in the binary, dist/ui/index.html in development. */
const loadPage = async (): Promise<string> => {
  if (inSea()) {
    try {
      return textAsset("ui.html");
    } catch {
      return MISSING_UI;
    }
  }
  try {
    return await readFile(new URL("../../dist/ui/index.html", import.meta.url), "utf-8");
  } catch {
    return MISSING_UI;
  }
};

/** Constant-time token check (hash both sides so lengths never leak). */
const tokenMatches = (header: string | undefined, token: string): boolean => {
  const presented = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim() ?? "";
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
};

/** Write a response, gzipped when the client takes it (the page is ~480 KB raw, ~145 KB gzipped). */
const send = (req: http.IncomingMessage, res: http.ServerResponse, status: number, type: string, body: string): void => {
  const headers: http.OutgoingHttpHeaders = {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    vary: "accept-encoding"
  };
  let payload: Buffer = Buffer.from(body);
  if (payload.length > 1024 && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    payload = gzipSync(payload);
    headers["content-encoding"] = "gzip";
  }
  headers["content-length"] = payload.length;
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : payload);
};

const json = (req: http.IncomingMessage, res: http.ServerResponse, status: number, value: unknown): void =>
  send(req, res, status, "application/json; charset=utf-8", JSON.stringify(value));

const handle = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  page: () => Promise<string>,
  addons: WebAddon[]
): Promise<void> => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method !== "GET" && req.method !== "HEAD") {
    json(req, res, 405, { error: "method not allowed" });
    return;
  }

  if (url.pathname === "/api/health") {
    json(req, res, 200, { ok: true, auth: env.UI_TOKEN !== undefined });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (env.UI_TOKEN !== undefined && !tokenMatches(req.headers.authorization, env.UI_TOKEN)) {
      res.setHeader("www-authenticate", 'Bearer realm="gene"');
      json(req, res, 401, { error: "unauthorized" });
      return;
    }
    if (url.pathname === "/api/overview") {
      const days = Number(url.searchParams.get("days") ?? DEFAULT_WINDOW_DAYS);
      const overview = await buildOverview(Number.isFinite(days) ? days : DEFAULT_WINDOW_DAYS);
      json(req, res, 200, { ...overview, addons: addons.map(a => a.name) });
      return;
    }
    for (const addon of addons) {
      const route = addon.routes[url.pathname];
      if (route) {
        json(req, res, 200, await route(url));
        return;
      }
    }
    json(req, res, 404, { error: "not found" });
    return;
  }

  // Everything else is the single-page app.
  send(req, res, 200, "text/html; charset=utf-8", await page());
};

/**
 * Start listening. Never throws: a bind failure (port taken, bad host) is logged and the
 * daemon carries on without the UI. Resolves to a stop function.
 */
export const startWebUi = async (address: { host: string; port: number }, addons: WebAddon[] = []): Promise<() => void> => {
  // In the binary the page never changes — read it once. In development re-read it per
  // request, so a `pnpm build:ui` shows up on reload without restarting the daemon.
  let cached: string | null = null;
  const page = async (): Promise<string> => {
    if (!inSea()) return loadPage();
    cached ??= await loadPage();
    return cached;
  };

  const server = http.createServer((req, res) => {
    handle(req, res, page, addons).catch(error => {
      logger.warn(`${logger.tag.web} ${req.method} ${req.url} failed:`, error instanceof Error ? error.message : error);
      if (!res.headersSent) json(req, res, 500, { error: "internal error" });
      else res.end();
    });
  });

  const loopback = ["127.0.0.1", "::1", "localhost"].includes(address.host);
  if (!loopback && env.UI_TOKEN === undefined) {
    logger.warn(
      `${logger.tag.web} the web UI binds ${address.host} with no token — anyone who can reach it can read ` +
        "ticket titles and comments. Set GENE_UI_TOKEN (or UI_TOKEN) to require one."
    );
  }

  return new Promise(resolve => {
    server.once("error", error => {
      logger.error(
        `${logger.tag.web} could not start the web UI on ${address.host}:${address.port}:`,
        error instanceof Error ? error.message : error
      );
      resolve(() => {});
    });
    server.listen(address.port, address.host, () => {
      const shown = address.host.includes(":") ? `[${address.host}]` : address.host;
      logger.info(
        `${logger.tag.web} web UI on http://${shown}:${address.port}/` +
          (env.UI_TOKEN ? " (token required)" : "") +
          (addons.length ? ` with ${addons.map(a => a.name).join(", ")}` : "") +
          ` — runs window up to ${MAX_WINDOW_DAYS} days`
      );
      // Never hold the process open on its own: the daemon loop owns the lifetime.
      server.unref();
      resolve(() => server.close());
    });
  });
};
