import { readdir, rm } from "node:fs/promises";
import path from "node:path";
// The LLM CONNECTORS' log directories are not imported at all: each connector
// (openai/anthropic/gemini — every adapter relocated out of packages/llm in
// cinatra#1715) exposes its `logDirectory` on its `llm-provider-surface`
// capability (lazy/guarded host-access cutover), resolved at CALL time inside
// clearAllProviderLogEntries — an absent connector's directory is simply not
// cleared (degraded), and module-init carries no connector edge.
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
import {
  writeConnectorConfigToDatabase,
  readAnthropicLoggingEnabledFromDatabase,
  ANTHROPIC_LOGGING_CONFIG_KEY,
} from "@/lib/database";
import { getLlmProviderSurface, listLlmProviderSurfaces } from "@/lib/llm-provider-surfaces";

// Host-owned log directories (static). Connector-owned directories (including
// Anthropic's, now that its adapter+writer relocated into the anthropic
// connector — cinatra#1715) resolve from the live llm-provider surfaces at call
// time via `allProviderLogDirectories`.
const HOST_LOG_DIRECTORIES = [
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

export function getAnthropicLoggingSettings() {
  return {
    // Read from the PERSISTED authority (#1715 D2) — the same store the
    // connector-relocated adapter's log writer reads, so the UI display never
    // diverges from what the writer actually honors.
    enabled: readAnthropicLoggingEnabledFromDatabase(),
    // The Anthropic log directory is connector-owned post-relocation (#1715):
    // resolve it from the live surface. Absent connector ⇒ undefined (no
    // writer, nothing to display).
    directory: getLlmProviderSurface("anthropic")?.logDirectory,
  };
}

export async function saveAnthropicLoggingSettings(enabled: boolean) {
  // Authority write (#1715 D2): persist into the connector-config store. This
  // is the single value the Anthropic log writer gates on — now cross-realm, in
  // the anthropic connector. The admin write stays host-side; the connector
  // only READS. There is no in-process module-state cache to warm anymore (the
  // `anthropic-logging-state` leaf relocated out of packages/llm).
  writeConnectorConfigToDatabase(ANTHROPIC_LOGGING_CONFIG_KEY, { enabled });
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
