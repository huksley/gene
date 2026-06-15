/**
 * DollarDeploy preview-deployment plugin for Gene.
 *
 * Spins up a per-ticket preview environment on DollarDeploy when a ticket's change
 * request passes CI, and tears it down when the ticket is marked Done:
 *
 *   - on `ci-completed` (passed): find the repo's existing dev/staging app, duplicate
 *     it, rename the copy `<repo>-<ticket-id>`, point it at the ticket's branch and a
 *     custom subdomain under the host's wildcard, then build + deploy it.
 *   - on `issue-status-changed` → Done: remove that preview app.
 *
 * It's a pure observer (like every Gene plugin): all failures are caught by the
 * dispatcher, and it honours GENE_DRY_RUN (logs intended calls, writes nothing).
 *
 * Config (read from the process env, not Gene's config):
 *   - DOLLARDEPLOY_API_KEY — API token. Falls back to `~/.dollardeploy/auth` (the
 *     file `ddc auth` writes: `{ "apiKey": "sk_…" }`).
 *   - DOLLARDEPLOY_BASE_URL — defaults to https://dollardeploy.com.
 *
 * Enable via GENE_PLUGINS=src/plugins/dollardeploy.ts (or a built dist path).
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchRetryTimeout } from "../fetch.ts";
import { resolveTarget } from "../repos.ts";
import type { GeneEvent, Plugin, PluginContext } from "./index.ts";
import type { Issue } from "../tracker/index.ts";

/** The subset of a DollarDeploy app we care about (GET /api/app). */
type DdApp = {
  id: string;
  name: string;
  repositoryUrl?: string | null;
  hostId?: string | null;
  hostname?: string | null;
  status?: string | null;
};

// --- Pure helpers (exported for tests) --------------------------------------

/** Canonical repo key for comparison: host/path, lowercased, sans scheme/.git/trailing slash. */
export const normalizeRepoUrl = (url: string | null | undefined): string =>
  (url ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

/** True when two repo URLs point at the same repository. */
export const sameRepo = (a: string | null | undefined, b: string | null | undefined): boolean =>
  normalizeRepoUrl(a) !== "" && normalizeRepoUrl(a) === normalizeRepoUrl(b);

/** dev/staging name tokens — recognised for base matching and stem stripping. */
const DEV_STAGING_TOKENS = new Set(["dev", "development", "staging"]);

/** True when any `-`/`.`-separated token of `s` is a dev/staging token. */
const hasDevStagingToken = (s: string): boolean =>
  s.split(/[-.]/).some(p => DEV_STAGING_TOKENS.has(p.toLowerCase()));

/**
 * An app is a dev/staging base when its name carries a dev/staging token, or its
 * hostname's *first label* (the subdomain) does — e.g. `dev.example.com`. Only the
 * first label is checked so the `.dev` TLD of `app4.x.dollardeploy.dev` isn't a match.
 */
export const isDevStagingApp = (app: DdApp): boolean =>
  hasDevStagingToken(app.name ?? "") || hasDevStagingToken((app.hostname ?? "").split(".")[0] ?? "");

/**
 * The stem of a base app's name with any dev/staging token removed — the preview
 * prefix: "app-staging" → "app", "staging-app" → "app", "nextjs" → "nextjs". Falls
 * back to the original name when stripping would leave nothing.
 */
export const baseAppNameStem = (name: string): string => {
  const parts = name.split(/[-.]/).filter(p => p && !DEV_STAGING_TOKENS.has(p.toLowerCase()));
  return parts.join("-") || name;
};

/** The preview app's name for a ticket, e.g. "nextjs-ID-244" (ticket case preserved). */
export const deploymentNameFor = (stem: string, ticketId: string): string => `${stem}-${ticketId}`;

/** A DNS-safe label (≤63 chars, lowercase, no leading/trailing dash). */
export const dnsLabel = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");

/**
 * Build the preview's custom hostname by swapping the first label of the base app's
 * hostname for the deployment label — e.g. base "app4.mh6i6q7v.dollardeploy.dev"
 * + "app-ID-601" → "app-id-601.mh6i6q7v.dollardeploy.dev". Returns undefined when the
 * base hostname isn't a subdomain we can derive from (so the caller skips the custom domain).
 */
export const customHostnameFrom = (baseHostname: string | null | undefined, deploymentName: string): string | undefined => {
  const labels = (baseHostname ?? "").split(".").filter(Boolean);
  if (labels.length < 3) {
    return undefined;
  }
  const label = dnsLabel(deploymentName);
  if (!label) {
    return undefined;
  }
  return [label, ...labels.slice(1)].join(".");
};

// --- Plugin -----------------------------------------------------------------

/** Read the API key from the env, falling back to the `ddc auth` file. */
const readApiKey = (): string => {
  const fromEnv = process.env.DOLLARDEPLOY_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const raw = readFileSync(path.join(os.homedir(), ".dollardeploy", "auth"), "utf8");
    const parsed = JSON.parse(raw) as { apiKey?: string };
    return parsed.apiKey?.trim() ?? "";
  } catch {
    return "";
  }
};

const createPlugin = (): Plugin => {
  let apiKey = "";
  let baseUrl = "https://dollardeploy.com";

  /** One authed JSON API call; throws on a non-2xx so the dispatcher logs it. */
  const api = async <T>(method: string, apiPath: string, body?: unknown): Promise<T> => {
    const res = await fetchRetryTimeout(`${baseUrl}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`DollarDeploy ${method} ${apiPath} → ${res.status} ${detail.slice(0, 300)}`);
    }
    return (res.status === 204 ? null : await res.json()) as T;
  };

  const listApps = (): Promise<DdApp[]> =>
    api<DdApp[] | { apps?: DdApp[]; data?: DdApp[] }>("GET", "/api/app").then(r =>
      Array.isArray(r) ? r : (r.apps ?? r.data ?? [])
    );

  /** Resolve a ticket's repo URL; null when no repo can be determined. */
  const repoFor = async (issue: Issue, ctx: PluginContext): Promise<{ url: string } | null> => {
    const comments = await ctx.tracker.getComments(issue).catch(() => []);
    const target = resolveTarget(issue, comments);
    return target ? { url: `https://${target.host}/${target.repoPath}` } : null;
  };

  const deployPreview = async (issue: Issue, ctx: PluginContext): Promise<void> => {
    const repo = await repoFor(issue, ctx);
    if (!repo) {
      ctx.logger.warn(`[dollardeploy] [${issue.identifier}] no repo resolved — skipping preview`);
      return;
    }
    const apps = await listApps();

    // Prefer the repo's dev/staging app as the template; fall back to any app on the
    // same repo (so a plain "nextjs" app yields "nextjs-<ticket>"). Naming derives from
    // the chosen app's stem, so the idempotency check below needs the base resolved first.
    const sameRepoApps = apps.filter(a => sameRepo(a.repositoryUrl, repo.url));
    const base = sameRepoApps.find(isDevStagingApp) ?? sameRepoApps[0];
    if (!base) {
      ctx.logger.warn(
        `[dollardeploy] [${issue.identifier}] no app found for ${repo.url} — ` +
        "create one (a *-dev/*-staging app, or any app on this repo) to seed previews from"
      );
      return;
    }
    const name = deploymentNameFor(baseAppNameStem(base.name), issue.identifier);

    if (apps.some(a => a.name === name)) {
      ctx.logger.info(`[dollardeploy] [${issue.identifier}] preview "${name}" already exists — nothing to do`);
      return;
    }

    const hostname = customHostnameFrom(base.hostname, name);
    if (ctx.dryRun) {
      ctx.logger.info(
        `[dollardeploy] [${issue.identifier}] (dry-run) would duplicate "${base.name}" → "${name}" ` +
        `on branch ${issue.branchName}${hostname ? ` at ${hostname}` : ""} and deploy`
      );
      return;
    }

    const dup = await api<DdApp>("POST", `/api/app/${base.id}/duplicate`);
    // Ensure the host serves the wildcard the custom subdomain falls under (best-effort —
    // it usually already exists, since the base app resolves under the same wildcard).
    if (hostname && base.hostId) {
      const wildcardBase = hostname.split(".").slice(1).join(".");
      await api("POST", `/api/host/${base.hostId}/hostname/wildcard`, { hostname: wildcardBase }).catch(error =>
        ctx.logger.warn(`[dollardeploy] [${issue.identifier}] wildcard ensure failed (continuing):`, error instanceof Error ? error.message : error)
      );
    }
    await api("PATCH", `/api/app/${dup.id}`, {
      name,
      sourceBranch: issue.branchName,
      ...(hostname ? { hostname } : {})
    });
    await api("POST", `/api/app/${dup.id}/build`, { deploy: true });
    ctx.logger.info(
      `[dollardeploy] [${issue.identifier}] preview "${name}" deploying` +
      `${hostname ? ` → https://${hostname}` : ""} (from "${base.name}", branch ${issue.branchName})`
    );
  };

  const removePreview = async (issue: Issue, ctx: PluginContext): Promise<void> => {
    const repo = await repoFor(issue, ctx);
    const suffix = `-${issue.identifier}`.toLowerCase();
    const apps = await listApps();
    const targets = apps.filter(a => {
      if (!a.name.toLowerCase().endsWith(suffix)) {
        return false;
      }
      // When the repo is known, only remove previews of that repo (ticket ids are unique
      // per workspace anyway, but this keeps it tight); otherwise fall back to the suffix.
      return repo ? sameRepo(a.repositoryUrl, repo.url) : true;
    });
    if (targets.length === 0) {
      ctx.logger.info(`[dollardeploy] [${issue.identifier}] no preview app to remove`);
      return;
    }
    for (const app of targets) {
      if (ctx.dryRun) {
        ctx.logger.info(`[dollardeploy] [${issue.identifier}] (dry-run) would remove preview "${app.name}" (${app.id})`);
        continue;
      }
      await api("POST", `/api/app/${app.id}/remove`, { deleteApp: true });
      ctx.logger.info(`[dollardeploy] [${issue.identifier}] removed preview "${app.name}"`);
    }
  };

  return {
    name: "dollardeploy",

    setup(ctx: PluginContext): void {
      apiKey = readApiKey();
      baseUrl = (process.env.DOLLARDEPLOY_BASE_URL?.trim() || "https://dollardeploy.com").replace(/\/+$/, "");
      if (!apiKey) {
        ctx.logger.warn(
          "[dollardeploy] no API key (set DOLLARDEPLOY_API_KEY or run `ddc auth`) — plugin loaded but inert"
        );
      } else {
        ctx.logger.info(`[dollardeploy] active (base ${baseUrl})`);
      }
    },

    async handle(event: GeneEvent, ctx: PluginContext): Promise<void> {
      if (!apiKey) {
        return;
      }
      if (event.kind === "ci-completed" && event.status === "passed") {
        await deployPreview(event.issue, ctx);
        return;
      }
      if (event.kind === "issue-status-changed") {
        const doneState = ctx.env.DONE_STATE ?? "Done";
        if (event.to === doneState) {
          await removePreview(event.issue, ctx);
        }
      }
    }
  };
};

export default createPlugin;
