import { getMcpPublicBaseUrl } from "@cinatra-ai/mcp-server/credentials";

// getMcpPublicBaseUrl reads through the same cache as readConnectorConfigFromDatabase
// and clamps non-"manual" rows to null — so legacy quick-tunnel URLs no longer leak
// out through this endpoint.

export async function GET() {
  // Invalidate the in-memory cache so we get the latest value from DB.
  const cache = (globalThis as Record<string, unknown>).__cinatraConnectorConfigCache as Map<string, unknown> | undefined;
  if (cache) {
    cache.delete("connector_config:mcp_server");
  }

  const { publicBaseUrl } = getMcpPublicBaseUrl();
  return Response.json({ publicBaseUrl });
}
