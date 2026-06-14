/**
 * Plugin system — lets external code observe the daemon's lifecycle without touching
 * the pipeline. Plugins are pure observers: every dispatch is wrapped so a misbehaving
 * plugin can never break the daemon action it describes (the same discipline as the
 * telemetry monitor in src/monitor.ts).
 *
 * Plugins are loaded at startup from `GENE_PLUGINS` — a comma-separated list of module
 * paths and/or directories. Each module default-exports a {@link Plugin}, or a factory
 * returning one. A directory entry loads every non-test `*.ts`/`*.js` inside it.
 *
 * Events are dispatched from a handful of sites in the daemon:
 *   - `agent-started` / `agent-finished` — around each dispatched agent run (index.ts)
 *   - `issue-status-changed` — one chokepoint diffing each scan (index.ts), so it
 *     catches both daemon-driven moves and human drags
 *   - `pr-created` / `ci-completed` — the In-Review watchdog (index.ts processReview)
 */

import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { env } from "../config.ts";
import logger from "../logger.ts";
import { tracker, type Issue } from "../tracker/index.ts";
import type { PromptIntent } from "../prompt.ts";
import type { AgentStatus } from "../monitor.ts";

/** One observable thing that happened to a ticket / its agent / its change request. */
export type GeneEvent =
  | { kind: "agent-started"; issue: Issue; intent: PromptIntent }
  | { kind: "agent-finished"; issue: Issue; status: AgentStatus }
  | { kind: "issue-status-changed"; issue: Issue; from: string; to: string }
  | { kind: "pr-created"; issue: Issue; url: string; forge: string }
  | { kind: "ci-completed"; issue: Issue; status: "passed" | "failed"; url?: string };

/** Stable handle passed to every plugin call — the daemon's neutral surfaces. */
export interface PluginContext {
  tracker: typeof tracker;
  env: typeof env;
  logger: typeof logger;
  /** True under GENE_DRY_RUN — a plugin that writes externally should honour it. */
  dryRun: boolean;
}

export interface Plugin {
  /** Identifies the plugin in logs. */
  name: string;
  /** Optional one-time init at startup (register webhooks, open clients, …). */
  setup?(ctx: PluginContext): void | Promise<void>;
  /** Called for every {@link GeneEvent}. Must not throw — the dispatcher guards anyway. */
  handle(event: GeneEvent, ctx: PluginContext): void | Promise<void>;
}

/** A plugin module may export the plugin directly or a factory that builds one. */
type PluginModule = { default?: Plugin | ((ctx: PluginContext) => Plugin | Promise<Plugin>) };

const registry: Plugin[] = [];

let context: PluginContext | undefined;
const ctx = (): PluginContext =>
  (context ??= { tracker, env, logger, dryRun: env.DRY_RUN });

/** Expand a GENE_PLUGINS entry to concrete module file paths (a dir → its members). */
const resolveEntry = async (entry: string): Promise<string[]> => {
  const abs = isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
  try {
    const names = await readdir(abs);
    // It's a directory — load every non-test module file inside it.
    return names
      .filter(n => /\.(ts|js|mjs)$/.test(n) && !/\.(test|d)\./.test(n))
      .sort()
      .map(n => join(abs, n));
  } catch {
    // Not a directory (ENOTDIR) or unreadable — treat the entry as a single module path.
    return [abs];
  }
};

/** Import one plugin module and return its Plugin (resolving a factory export). */
const loadOne = async (modulePath: string): Promise<Plugin | null> => {
  let mod: PluginModule;
  try {
    mod = (await import(pathToFileURL(modulePath).href)) as PluginModule;
  } catch (error) {
    logger.error(`${logger.tag.flow} [plugins] failed to import ${modulePath}:`, error instanceof Error ? error.message : error);
    return null;
  }
  const exported = mod.default;
  if (!exported) {
    logger.warn(`${logger.tag.flow} [plugins] ${modulePath} has no default export — skipping`);
    return null;
  }
  try {
    const plugin = typeof exported === "function" ? await exported(ctx()) : exported;
    if (!plugin || typeof plugin.handle !== "function") {
      logger.warn(`${logger.tag.flow} [plugins] ${modulePath} default export is not a Plugin — skipping`);
      return null;
    }
    return plugin;
  } catch (error) {
    logger.error(`${logger.tag.flow} [plugins] factory in ${modulePath} threw:`, error instanceof Error ? error.message : error);
    return null;
  }
};

/**
 * Load and initialize every configured plugin. Best-effort and idempotent: a bad path
 * or a throwing `setup` is logged and skipped, never crashing daemon startup. Call once.
 */
export const setupPlugins = async (): Promise<void> => {
  registry.length = 0;
  if (!env.PLUGINS) {
    return;
  }
  const entries = env.PLUGINS.split(",").map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    for (const modulePath of await resolveEntry(entry)) {
      const plugin = await loadOne(modulePath);
      if (!plugin) {
        continue;
      }
      try {
        await plugin.setup?.(ctx());
      } catch (error) {
        logger.error(`${logger.tag.flow} [plugins] ${plugin.name} setup failed:`, error instanceof Error ? error.message : error);
        continue;
      }
      registry.push(plugin);
      logger.info(`${logger.tag.flow} [plugins] loaded ${plugin.name} (${modulePath})`);
    }
  }
  if (registry.length > 0) {
    logger.info(`${logger.tag.flow} [plugins] ${registry.length} plugin(s) active`);
  }
};

/**
 * Fan an event out to every loaded plugin. Each plugin is awaited and individually
 * guarded — one slow or throwing plugin neither blocks the others nor the daemon.
 * A no-op (and zero cost) when no plugins are loaded.
 */
export const dispatch = async (event: GeneEvent): Promise<void> => {
  if (registry.length === 0) {
    return;
  }
  for (const plugin of registry) {
    try {
      await plugin.handle(event, ctx());
    } catch (error) {
      logger.error(
        `${logger.tag.flow} [plugins] ${plugin.name} failed on ${event.kind}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
};
