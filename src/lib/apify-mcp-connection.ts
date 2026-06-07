import "server-only";

import { getApifySettings } from "@cinatra-ai/apify-connector";
import {
  buildBearerAuthHeaderFromNango,
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  isNangoConfigured,
} from "@cinatra-ai/nango-connector";
import type { LlmMcpServerTool, LlmProvider } from "@cinatra-ai/llm";

// ---------------------------------------------------------------------------
// First-party Apify MCP tool builder.
//
// Parallel to `buildDrupalMcpServerTools` (`src/lib/drupal-mcp-connection.ts`)
// and `buildWordPressMcpServerTools` (`src/lib/wordpress-mcp-connection.ts`).
// Apify leaves `external_mcp_servers` entirely; this builder is the only
// injection path for the Apify MCP server.
//
// The Bearer token comes from the Nango vault under the cinatra-apify
// integration (provider: "apify"). The MCP server URL stays clean
// (`https://mcp.apify.com`); the token rides in the `Authorization` header.
// ---------------------------------------------------------------------------

const APIFY_MCP_URL = "https://mcp.apify.com";
const APIFY_MCP_LABEL = "apify-connector";

export async function buildApifyMcpServerTools(
  _provider: LlmProvider,
): Promise<LlmMcpServerTool[]> {
  try {
    const settings = getApifySettings();
    if (!isNangoConfigured()) {
      // Fail closed loudly, matching Drupal's builder. Only warn when there's
      // actually a connection that would otherwise have been injected.
      if (settings.nangoConnectionId) {
        console.warn(
          "[apify-mcp-connection] Nango not configured — Apify MCP server disabled (connector: apify)",
        );
      }
      return [];
    }
    if (!settings.nangoConnectionId) {
      // No stored connection to inject.
      return [];
    }
    const headers = await buildBearerAuthHeaderFromNango({
      providerConfigKey: CINATRA_NANGO_PROVIDER_CONFIG_KEYS.apify,
      connectionId: settings.nangoConnectionId,
      label: "apify",
    });
    if (!headers) {
      // Helper already warned about the connection label (no token).
      return [];
    }
    return [
      {
        type: "mcp",
        serverLabel: APIFY_MCP_LABEL,
        serverUrl: APIFY_MCP_URL,
        headers,
        serverDescription: "Apify MCP — actor tools",
        allowedTools: null,
        requireApproval: "never",
      },
    ];
  } catch (err) {
    console.warn(
      `[apify-mcp-connection] buildApifyMcpServerTools failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
