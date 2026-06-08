import { z } from "zod";

const Env = z.object({
  TRELLO_API_KEY: z
    .string()
    .min(1, "TRELLO_API_KEY is required — see scripts/ai-pipeline/README.md"),
  TRELLO_TOKEN: z
    .string()
    .min(1, "TRELLO_TOKEN is required — see scripts/ai-pipeline/README.md"),
  AI_PIPELINE_BOARD_ID: z.string().default("69f464e71c2daae438c02a8b"),
  AI_PIPELINE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  AI_PIPELINE_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(30_000),
  AI_PIPELINE_MAX_CONCURRENT: z.coerce.number().int().positive().default(2),
  TRELLO_API_SECRET: z.string().optional(),
  AI_PIPELINE_TUNNEL_URL: z.string().url().optional(),
  DOLLARDEPLOY_API_KEY: z.string().optional(),
  DOLLARDEPLOY_MCP_URL: z.string().url().default("https://dollardeploy.com/api/mcp")
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  /* eslint-disable no-console */
  console.error("[ai-pipeline] missing or invalid env vars:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error("\nSet them in .env.local (gitignored). See scripts/ai-pipeline/README.md.");
  /* eslint-enable no-console */
  process.exit(1);
}
export const env = parsed.data;

export const LISTS = {
  AI_CODE_ASSISTANT: "69f8e849242e227b9f6b97af",
  IN_PROCESS_AI: "6a206b3c18c5fade7a356182",
  TESTING: "69f464f0198e13f4f31f6af2",
  TESTING_DD: "6a22f8c32cb90bdf7f5b6039",
  DONE: "69f464f6695351a186d7937e"
} as const;

export const LIST_NAMES: Record<string, string> = {
  [LISTS.AI_CODE_ASSISTANT]: "AI Code Assistant",
  [LISTS.IN_PROCESS_AI]: "In Process (AI)",
  [LISTS.TESTING]: "Testing",
  [LISTS.TESTING_DD]: "🧪 Testing on testing.welby.ch",
  [LISTS.DONE]: "Done - Ready for Prod"
};

export const LABELS = {
  AI_BLOCKED: "6a206b3e128bbfa2521e9885",
  AI_DONE: "6a206b412f640195db4d6e4f",
  AI_WORKING: "6a214bfda6ff1394485f9c37"
} as const;

export const AGENT_MEMBER_ID = "698b0c4104d8d855eec1b65d";

export const REQUIRED_DESC_SECTIONS = ["## Problem", "## Acceptance criteria"] as const;

/**
 * DollarDeploy scoping — HARDCODED. The pipeline's DD client refuses to operate
 * on any other app. If the welby-testing app is ever recreated, only update
 * the name here (id is resolved at startup by name lookup).
 */
export const DOLLARDEPLOY_APP_NAME = "welby-testing" as const;
export const DOLLARDEPLOY_TESTING_HOSTNAME = "testing.welby.ch" as const;
