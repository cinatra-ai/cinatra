import "server-only";

import {
  listEnabledGlobalExternalMcpServers,
  EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
} from "@/lib/external-mcp-registry";
import { getNangoCredentials, isNangoConfigured } from "@/lib/nango-system";

// ---------------------------------------------------------------------------
// Internal helper — resolve API key for a server's Nango connection if available
// ---------------------------------------------------------------------------

async function resolveAuthHeader(
  nangoConnectionId: string | null,
): Promise<{ Authorization: string } | undefined> {
  if (!nangoConnectionId || !isNangoConfigured()) {
    return undefined;
  }
  try {
    const credentials = await getNangoCredentials(
      EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
      nangoConnectionId,
    );
    const apiKey =
      credentials && typeof credentials === "object" && "apiKey" in credentials
        ? (credentials as { apiKey: string }).apiKey
        : typeof credentials === "string"
          ? credentials
          : null;
    if (apiKey) {
      return { Authorization: `Bearer ${apiKey}` };
    }
  } catch {
    // Nango unavailable — proceed without auth header
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// fetchExternalMcpToolNames
//
// Fetches tool names from all enabled global external MCP servers.
// Per-server failures are caught and logged — never thrown.
// Returns deduplicated string[]; empty array when none are registered or all fail.
// ---------------------------------------------------------------------------

export async function fetchExternalMcpToolNames(): Promise<string[]> {
  const servers = listEnabledGlobalExternalMcpServers();
  const allNames: string[] = [];

  for (const row of servers) {
    try {
      const authHeader = await resolveAuthHeader(row.nangoConnectionId);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(authHeader ?? {}),
      };

      const response = await fetch(row.serverUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const json = await response.json() as {
        result?: { tools?: Array<{ name: string }> };
        error?: unknown;
      };

      if (!json.result?.tools || !Array.isArray(json.result.tools)) {
        throw new Error("Response missing result.tools array");
      }

      for (const tool of json.result.tools) {
        if (tool.name) {
          allNames.push(tool.name);
        }
      }
    } catch (err) {
      console.log(
        `[external-mcp-caller] skipping ${row.label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Deduplicate
  return [...new Set(allNames)];
}

// ---------------------------------------------------------------------------
// callExternalMcpTool
//
// Finds the registered server that exports `toolName` (via tools/list) and
// dispatches a tools/call request to it. Never swallows errors from the call
// itself — they must propagate so the caller's retry/failFast logic applies.
// Throws if no registered server exports the tool.
// ---------------------------------------------------------------------------

export async function callExternalMcpTool(
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<unknown> {
  const servers = listEnabledGlobalExternalMcpServers();

  for (const row of servers) {
    let authHeader: { Authorization: string } | undefined;
    try {
      authHeader = await resolveAuthHeader(row.nangoConnectionId);
    } catch {
      // Proceed without auth header
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(authHeader ?? {}),
    };

    // First, check whether this server exports the tool
    let ownsTheTool = false;
    try {
      const listResponse = await fetch(row.serverUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(5000),
      });

      if (listResponse.ok) {
        const listJson = await listResponse.json() as {
          result?: { tools?: Array<{ name: string }> };
        };
        if (Array.isArray(listJson.result?.tools)) {
          ownsTheTool = listJson.result.tools.some((t) => t.name === toolName);
        }
      }
    } catch {
      // Server unreachable — skip to next
      continue;
    }

    if (!ownsTheTool) {
      continue;
    }

    // This server owns the tool — dispatch the call
    const callResponse = await fetch(row.serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: toolArgs },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!callResponse.ok) {
      throw new Error(
        `External MCP server "${row.label}" returned HTTP ${callResponse.status} for tools/call`,
      );
    }

    const callJson = await callResponse.json() as {
      result?: unknown;
      error?: { message?: string };
    };

    if (callJson.error) {
      throw new Error(
        callJson.error.message ?? JSON.stringify(callJson.error),
      );
    }

    return callJson.result;
  }

  throw new Error(`External MCP tool "${toolName}" not found on any registered server`);
}
