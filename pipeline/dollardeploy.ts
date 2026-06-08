/**
 * DollarDeploy MCP client wrapper, intentionally narrow.
 *
 * Design intent (from user, 2026-06-05):
 *  - The MCP server is the only API DollarDeploy exposes (no REST). We use
 *    MCP at runtime, but with a SINGLE cached session per daemon, and only
 *    via the named methods below — never raw `tools/list` or `tools/call`
 *    from elsewhere in the pipeline.
 *  - **Hardcoded scoping**: this client refuses to operate on any app other
 *    than `DOLLARDEPLOY_APP_NAME` (currently `welby-testing`). The app id is
 *    resolved by name at startup so recreating the app doesn't break us.
 *  - Defensive against ID drift: every call internally references the app
 *    by the resolved id, not by name (DD's API requires id), but the id is
 *    only set by `init()` after verifying the app's name matches.
 *
 * Public surface (everything the daemon should ever need):
 *  - `getApp()` — current branch, status, last build/deploy timestamps
 *  - `setBranch(branch)` — switch the source branch via update-app
 *  - `buildAndDeploy()` — build current branch and deploy in one step; returns task id
 *  - `getTask(taskId)` — task status
 *  - `getTaskLogs(taskId)` — task logs (used on failure)
 */

import { DOLLARDEPLOY_APP_NAME, env } from "./config";
import logger from "@/lib/logger";

type JsonRpcResponse<T = unknown> = {
  jsonrpc: "2.0";
  id: number;
  result?: {
    structuredContent?: T;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
};

type App = {
  id: string;
  name: string;
  status: "active" | "error" | "archived" | "draft" | string;
  sourceBranch: string | null;
  hostname: string | null;
  repositoryUrl: string | null;
  lastBuildAt: string | null;
  lastDeployAt: string | null;
};

type Task = {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | string;
  type: string;
  createdAt?: string;
  updatedAt?: string;
  executedAt?: string | null;
  error?: string | null;
  /**
   * DD chains build:app → deploy:app as two separate tasks. The outer wrapper
   * call returns the build task; we follow `nextTaskId` to track the deploy
   * through to its true completion before reporting success.
   */
  nextTaskId?: string | null;
};

let sessionId: string | null = null;
let nextRpcId = 1;
let resolvedAppId: string | null = null;

const apiUrl = (): string => `${env.DOLLARDEPLOY_MCP_URL}?apiKey=${env.DOLLARDEPLOY_API_KEY}`;

/**
 * Parse a streamed `text/event-stream` response and pull the first JSON-RPC
 * `data:` payload. DD's MCP transport sends one event per response.
 */
const parseSseResponse = async <T>(res: Response): Promise<JsonRpcResponse<T>> => {
  const text = await res.text();
  for (const rawLine of text.split("\n")) {
    if (rawLine.startsWith("data:")) {
      return JSON.parse(rawLine.slice(5).trim()) as JsonRpcResponse<T>;
    }
  }
  throw new Error(`No data event in DD response: ${text.slice(0, 200)}`);
};

const ensureApiKey = (): void => {
  if (!env.DOLLARDEPLOY_API_KEY) {
    throw new Error(
      "DOLLARDEPLOY_API_KEY missing from environment. Set it in .env.local before running the pipeline with the testing lane enabled."
    );
  }
};

const initializeSession = async (): Promise<void> => {
  ensureApiKey();
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextRpcId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "meridian-ai-pipeline", version: "0.1" }
      }
    })
  });
  if (!res.ok) {
    throw new Error(`DollarDeploy initialize failed: ${res.status} ${await res.text()}`);
  }
  sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error("DollarDeploy initialize did not return a session id");
  }
  // notify/initialized — required handshake step, no response expected
  await fetch(apiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    })
  });
};

const callTool = async <T>(toolName: string, args: Record<string, unknown>): Promise<T> => {
  if (!sessionId) {
    await initializeSession();
  }
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId as string,
      "mcp-protocol-version": "2025-03-26"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextRpcId++,
      method: "tools/call",
      params: { name: toolName, arguments: args }
    })
  });
  if (!res.ok) {
    // 404 / session expired → reset and retry once
    if (res.status === 404) {
      logger.warn("[dollardeploy] session expired, re-initializing");
      sessionId = null;
      return callTool<T>(toolName, args);
    }
    throw new Error(`DollarDeploy ${toolName} HTTP ${res.status}: ${await res.text()}`);
  }
  const payload = await parseSseResponse<T>(res);
  if (payload.error) {
    throw new Error(`DollarDeploy ${toolName} error: ${payload.error.message}`);
  }
  if (payload.result?.isError) {
    const msg = payload.result.content?.[0]?.text ?? "unknown tool error";
    throw new Error(`DollarDeploy ${toolName} tool error: ${msg}`);
  }
  if (!payload.result?.structuredContent) {
    throw new Error(`DollarDeploy ${toolName} returned no structuredContent`);
  }
  return payload.result.structuredContent;
};

/**
 * Find welby-testing's app id by name. Cached for the lifetime of the daemon.
 * If the name doesn't resolve to exactly one app, throws.
 */
const resolveAppId = async (): Promise<string> => {
  if (resolvedAppId) {
    return resolvedAppId;
  }
  const result = await callTool<{ apps: App[] }>("list-apps", { params: {} });
  const matches = result.apps.filter(app => app.name === DOLLARDEPLOY_APP_NAME);
  if (matches.length === 0) {
    throw new Error(
      `DollarDeploy app named "${DOLLARDEPLOY_APP_NAME}" not found. Available: ${result.apps.map(a => a.name).join(", ")}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple DollarDeploy apps named "${DOLLARDEPLOY_APP_NAME}" — refusing to act ambiguously. IDs: ${matches.map(a => a.id).join(", ")}`
    );
  }
  resolvedAppId = matches[0].id;
  logger.info(
    `[dollardeploy] resolved app "${DOLLARDEPLOY_APP_NAME}" → id ${resolvedAppId} (current branch: ${matches[0].sourceBranch ?? "<none>"})`
  );
  return resolvedAppId;
};

export const getApp = async (): Promise<App> => {
  const id = await resolveAppId();
  const result = await callTool<{ app: App }>("get-app", { params: { id } });
  return result.app;
};

export const setBranch = async (branch: string): Promise<void> => {
  if (!branch || typeof branch !== "string") {
    throw new Error(`setBranch: invalid branch ${JSON.stringify(branch)}`);
  }
  const id = await resolveAppId();
  await callTool("update-app", {
    params: { id },
    body: { sourceBranch: branch }
  });
};

export const buildAndDeploy = async (): Promise<{ taskId: string }> => {
  const id = await resolveAppId();
  const result = await callTool<{ task?: { id: string }; id?: string }>("build-app", {
    params: { id, deploy: true }
  });
  const taskId = result.task?.id ?? result.id;
  if (!taskId) {
    throw new Error(`build-app returned no task id: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return { taskId };
};

export const getTask = async (taskId: string): Promise<Task> => {
  const result = await callTool<{ task: Task }>("get-task", { params: { id: taskId } });
  return result.task;
};

export const getTaskLogs = async (taskId: string): Promise<string> => {
  const result = await callTool<{ logs?: string; content?: string }>("get-task-logs", {
    params: { id: taskId }
  });
  return result.logs ?? result.content ?? "";
};

/** Reset cached state — useful for tests or when forced to re-initialize. */
export const _reset = (): void => {
  sessionId = null;
  resolvedAppId = null;
  nextRpcId = 1;
};
