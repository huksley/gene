/**
 * Example plugin — logs every lifecycle event. Not loaded by default; enable it with:
 *
 *   GENE_PLUGINS=src/plugins/examples/logging.ts
 *
 * (or point GENE_PLUGINS at a directory containing your own plugin modules). Use it as a
 * template: copy this file, keep the `default`-exported {@link Plugin} shape, and replace
 * `handle` with whatever you need — post to Slack, hit a webhook, write metrics, etc.
 * `handle` may be async; throwing is safe (the dispatcher isolates each plugin).
 */

import type { GeneEvent, Plugin, PluginContext } from "../index.ts";

const describe = (event: GeneEvent): string => {
  switch (event.kind) {
    case "agent-started":
      return `agent started (${event.intent})`;
    case "agent-finished":
      return `agent finished (${event.status})`;
    case "issue-status-changed":
      return `status ${event.from} → ${event.to}`;
    case "pr-created":
      return `PR created ${event.url}`;
    case "ci-completed":
      return `pipeline ${event.status}${event.url ? ` (${event.url})` : ""}`;
  }
};

const plugin: Plugin = {
  name: "logging",
  handle(event: GeneEvent, ctx: PluginContext): void {
    ctx.logger.info(`${ctx.logger.tag.flow} [plugin:logging] ${event.issue.identifier}: ${describe(event)}`);
  }
};

export default plugin;
