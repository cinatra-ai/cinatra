// Marketplace MCP call helper for the CLI. Mirrors the TS http-client
// pattern (StreamableHTTPClientTransport, `cinatra-<kebab>` tool names,
// structuredContent-preferred parse) but stays in .mjs because the CLI is
// plain Node ESM with no TS loader.
//
// Brand wording: prose says "Cinatra"; `cinatra-ai` only for the npm scope
// / GitHub org. The Marketplace base URL is hardcoded; an env override is
// honored only outside production.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const MARKETPLACE_BASE_URL = "https://marketplace.cinatra.ai";
const MCP_ROUTE = "/wp-json/cinatra/mcp";

export function resolveMarketplaceBaseUrl(override) {
  if (process.env.NODE_ENV !== "production") {
    const candidate = (override ?? process.env.MARKETPLACE_BASE_URL ?? "").trim();
    if (candidate) {
      return candidate.replace(/\/+$/, "");
    }
  }
  return MARKETPLACE_BASE_URL;
}

function authHeaders(token) {
  if (!token) return {};
  const value = /^(Bearer|Basic)\s/i.test(token) ? token : `Bearer ${token}`;
  return { Authorization: value };
}

function extractText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return null;
  const textItem = content.find((c) => c.type === "text");
  return textItem && typeof textItem.text === "string" ? textItem.text : null;
}

/**
 * Build the MCP tool name from an extender ability snake_case key.
 *
 * The WP ability id is `cinatra/<kebab>`, but MCP tool names cannot contain a
 * `/`, so the WordPress mcp-adapter exposes them with the namespace separator
 * flattened to a dash: `cinatra-<kebab>`. Match the exposed name exactly, or
 * tool calls fail with "Tool not found: cinatra/<kebab>".
 */
function mcpToolName(abilityKey) {
  return `cinatra-${abilityKey.replace(/_/g, "-")}`;
}

/**
 * Connect to the marketplace MCP, call one tool, parse + return the result,
 * close the client. Throws on tool-level errors (with the marketplace's error
 * text included).
 */
export async function callMarketplaceTool(abilityKey, args, opts = {}) {
  const baseUrl = resolveMarketplaceBaseUrl(opts.baseUrl);
  // Token precedence: the CI vendor automation token (the submit-scope GitHub
  // org secret) wins, falling back to the instance principal token for
  // local/manual use. The publish CI path sets CINATRA_MARKETPLACE_VENDOR_TOKEN;
  // a developer's shell may still export MARKETPLACE_INSTANCE_TOKEN.
  const token =
    opts.token ??
    process.env.CINATRA_MARKETPLACE_VENDOR_TOKEN ??
    process.env.MARKETPLACE_INSTANCE_TOKEN;
  if (!token) {
    throw new Error(
      "No marketplace token set. Export CINATRA_MARKETPLACE_VENDOR_TOKEN (CI vendor token) " +
        "or MARKETPLACE_INSTANCE_TOKEN (local) before submitting to the marketplace.",
    );
  }

  const endpoint = new URL(baseUrl + MCP_ROUTE);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: authHeaders(token) },
  });
  const client = new Client({ name: "cinatra-cli", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: mcpToolName(abilityKey), arguments: args });
    if (result?.isError) {
      const text = extractText(result) ?? "unknown error";
      throw new Error(`Marketplace ${abilityKey} returned an error: ${text}`);
    }
    if (result?.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent;
    }
    const text = extractText(result);
    if (text != null) {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Marketplace ${abilityKey}: response was not JSON.`);
      }
    }
    throw new Error(`Marketplace ${abilityKey}: empty response.`);
  } finally {
    await client.close().catch(() => {});
  }
}
