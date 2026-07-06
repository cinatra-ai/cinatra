import { readdir, rm } from "node:fs/promises";
import path from "node:path";
// The Anthropic log directory + logging setter come from dependency-free LEAF
// subpaths of the host-owned llm package, never the heavy barrels (ESM
// init-cycle hazard — see the history on this file). The LLM CONNECTORS'
// log directories are no longer imported at all: each connector exposes its
// `logDirectory` on its `llm-provider-surface` capability (lazy/guarded
// host-access cutover), resolved at CALL time inside
// clearAllProviderLogEntries — an absent connector's directory is simply not
// cleared (degraded), and module-init carries no connector edge.
import { ANTHROPIC_API_LOG_DIRECTORY } from "@cinatra-ai/llm/anthropic-log-directory";
import { setAnthropicLoggingEnabled } from "@cinatra-ai/llm/anthropic-logging-state";
import { MCP_CLIENT_LOG_DIRECTORY, MCP_SERVER_LOG_DIRECTORY } from "@/lib/mcp-logging";
// The wordpress/linkedin API-capture directories are CONNECTOR-owned since
// cinatra#975 Wave 3 (the relocated clients write through the host #981
// `ctx.logger.capture` channel; the directory is the host-owned capture path
// each client publishes as a read-only display value). Resolved lazily at
// call time; an absent connector's directory is simply not cleared
// (degraded) — the same posture as the llm-provider surfaces.
import {
  resolveLinkedInConnectionClient,
  resolveWordPressInstanceAdmin,
} from "@/lib/connector-client-providers";
import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";
import { listLlmProviderSurfaces } from "@/lib/llm-provider-surfaces";

// Host-owned log directories (static). Connector-owned directories resolve
// from the live llm-provider surfaces at call time.
const HOST_LOG_DIRECTORIES = [
  ANTHROPIC_API_LOG_DIRECTORY,
  MCP_SERVER_LOG_DIRECTORY,
  MCP_CLIENT_LOG_DIRECTORY,
];

function allProviderLogDirectories(): string[] {
  const connectorDirs = listLlmProviderSurfaces()
    .map((surface) => surface.logDirectory)
    .filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
  const vendorClientDirs = [
    resolveWordPressInstanceAdmin()?.getWordPressLoggingSettings().directory,
    resolveLinkedInConnectionClient()?.getLoggingSettings().directory,
  ].filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
  return [...connectorDirs, ...vendorClientDirs, ...HOST_LOG_DIRECTORIES];
}

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
    allProviderLogDirectories().map(async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries.map((entry) => rm(path.join(directory, entry.name), { recursive: true, force: true })),
      );
    }),
  );
}
