import { readdir, rm } from "node:fs/promises";
import path from "node:path";
// Import the log-directory constants + Anthropic logging setter from
// dependency-free LEAF subpaths, never the heavy package barrels. The barrels
// import @/lib/database / @/lib/nango / export * and define these constants
// after those imports; pulling them via the barrel here closes an ESM
// module-init cycle that throws a TDZ "Cannot access '<X>_API_LOG_DIRECTORY'
// before initialization" ReferenceError under SSR. Leaf modules import only
// node:path (or nothing), so they cannot participate in the cycle.
import { APOLLO_API_LOG_DIRECTORY } from "@cinatra-ai/apollo-connector/log-directory";
import { GEMINI_API_LOG_DIRECTORY } from "@cinatra-ai/gemini-connector/log-directory";
import { OPENAI_API_LOG_DIRECTORY } from "@cinatra-ai/openai-connector/log-directory";
import { ANTHROPIC_API_LOG_DIRECTORY } from "@cinatra-ai/llm/anthropic-log-directory";
import { setAnthropicLoggingEnabled } from "@cinatra-ai/llm/anthropic-logging-state";
import { LINKEDIN_API_LOG_DIRECTORY } from "@/lib/linkedin-api";
import { MCP_CLIENT_LOG_DIRECTORY, MCP_SERVER_LOG_DIRECTORY } from "@/lib/mcp-logging";
import { WORDPRESS_API_LOG_DIRECTORY } from "@/lib/wordpress-api";
import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";

const LOG_DIRECTORIES = [
  OPENAI_API_LOG_DIRECTORY,
  ANTHROPIC_API_LOG_DIRECTORY,
  APOLLO_API_LOG_DIRECTORY,
  GEMINI_API_LOG_DIRECTORY,
  WORDPRESS_API_LOG_DIRECTORY,
  LINKEDIN_API_LOG_DIRECTORY,
  MCP_SERVER_LOG_DIRECTORY,
  MCP_CLIENT_LOG_DIRECTORY,
];

const ANTHROPIC_LOGGING_CONFIG_KEY = "anthropic-logging";

export function getAnthropicLoggingSettings() {
  const config = readConnectorConfigFromDatabase<{ enabled?: boolean }>(ANTHROPIC_LOGGING_CONFIG_KEY, {});
  return {
    enabled: config.enabled !== false,
    directory: ANTHROPIC_API_LOG_DIRECTORY,
  };
}

export async function saveAnthropicLoggingSettings(enabled: boolean) {
  writeConnectorConfigToDatabase(ANTHROPIC_LOGGING_CONFIG_KEY, { enabled });
  setAnthropicLoggingEnabled(enabled);
}

export async function clearAllProviderLogEntries() {
  await Promise.all(
    LOG_DIRECTORIES.map(async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries.map((entry) => rm(path.join(directory, entry.name), { recursive: true, force: true })),
      );
    }),
  );
}
