import { readConnectorConfigFromDatabase } from "@/lib/database";

const MCP_SERVER_SETTINGS_KEY = "mcp_server";

type StoredMcpSelfClientSettings = {
  publicBaseUrl?: string | null;
  selfClient?: {
    clientId?: string;
    clientSecret?: string | null;
    scope?: string;
  } | null;
};

export type McpSelfClientCredentials = {
  publicBaseUrl: string | null;
  clientId: string;
  clientSecret: string | null;
  scope: string | null;
};

export const MCP_SELF_CLIENT_HEADER_NAMES = {
  serverUrl: "X-Cinatra-MCP-Server-Url",
  clientId: "X-Cinatra-MCP-Client-Id",
  clientSecret: "X-Cinatra-MCP-Client-Secret",
  clientScope: "X-Cinatra-MCP-Client-Scope",
} as const;

export function readAppMcpSelfClientCredentials(): McpSelfClientCredentials | null {
  const settings = readConnectorConfigFromDatabase<StoredMcpSelfClientSettings>(MCP_SERVER_SETTINGS_KEY, {});
  const clientId = typeof settings.selfClient?.clientId === "string" ? settings.selfClient.clientId.trim() : "";
  if (!clientId) {
    return null;
  }

  const clientSecret =
    typeof settings.selfClient?.clientSecret === "string" && settings.selfClient.clientSecret.trim().length > 0
      ? settings.selfClient.clientSecret.trim()
      : null;
  const publicBaseUrl =
    typeof settings.publicBaseUrl === "string" && settings.publicBaseUrl.trim().length > 0 ? settings.publicBaseUrl.trim() : null;
  const scope =
    typeof settings.selfClient?.scope === "string" && settings.selfClient.scope.trim().length > 0
      ? settings.selfClient.scope.trim()
      : null;

  return {
    publicBaseUrl,
    clientId,
    clientSecret,
    scope,
  };
}

/**
 * Returns the local MCP server URL (always localhost) for in-process and same-machine client use.
 * Local clients bypass OAuth, so they must connect to localhost — not the public tunnel URL.
 */
export function getLocalMcpServerUrl(): string {
  const base = (
    process.env.BETTER_AUTH_URL ??
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
  return `${base}/api/mcp`;
}

export function buildAppMcpSelfClientHeaders() {
  const credentials = readAppMcpSelfClientCredentials();
  if (!credentials) {
    return {};
  }

  return {
    [MCP_SELF_CLIENT_HEADER_NAMES.clientId]: credentials.clientId,
    ...(credentials.clientSecret ? { [MCP_SELF_CLIENT_HEADER_NAMES.clientSecret]: credentials.clientSecret } : {}),
    [MCP_SELF_CLIENT_HEADER_NAMES.serverUrl]: getLocalMcpServerUrl(),
    ...(credentials.scope ? { [MCP_SELF_CLIENT_HEADER_NAMES.clientScope]: credentials.scope } : {}),
  } satisfies Record<string, string>;
}
