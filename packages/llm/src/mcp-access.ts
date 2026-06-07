/**
 * LLM MCP access — thin adapter that re-exports credential helpers from
 * @cinatra-ai/mcp-server (the authoritative owner of MCP OAuth credentials)
 * and provides the orchestration-layer buildLlmMcpServerTool function.
 */

import "server-only";

import type { LlmProvider, LlmMcpServerTool } from "./types";
import { buildWordPressMcpServerTools } from "@/lib/wordpress-mcp-connection";
import { buildDrupalMcpServerTools } from "@/lib/drupal-mcp-connection";
import { buildApifyMcpServerTools } from "@/lib/apify-mcp-connection";
import { getPublicMcpServerUrl, getLlmMcpCredentials, getLocalTokenEndpointUrl, getLocalMcpServerUrl } from "@cinatra-ai/mcp-server/credentials";

// Re-export so existing callers don't need to change their imports.
export { getPublicMcpServerUrl, getLlmMcpCredentials, hasLlmMcpAccess, getLlmMcpAccessStatus } from "@cinatra-ai/mcp-server/credentials";

const AUTH_BASE_PATH = "/api/auth";

// Chat → MCP delegated actor token plumbing. The token issuer lives in the
// app layer (src/lib/chat-mcp-actor-token.ts) because it signs with
// BETTER_AUTH_SECRET and resolves trusted MCP audiences; this shared
// infrastructure package must not import @/ , so the issuer is injected.
export type ChatMcpActor = {
  /**
   * Discriminator for the DelegatedMcpActor union — distinguishes chat-OBO
   * from agent-run-OBO at the MCP transport. Always `"chat"` here.
   */
  delegation: "chat";
  userId: string;
  orgId: string | null;
  platformRole: "platform_admin" | "member";
};

/**
 * Actor shape for the agent-run delegated MCP path. Mirrors `ChatMcpActor`
 * but discriminates `"agent_run"` and carries the run-bound claims
 * (`orgId` non-nullable, `runId` required). The token issuer lives in
 * `src/lib/agent-run-mcp-actor-token.ts` and is injected via
 * `AgentRunMcpActorTokenIssuer` so this package stays `@/`-free.
 */
export type AgentRunMcpActor = {
  delegation: "agent_run";
  userId: string;
  orgId: string;
  runId: string;
  platformRole: "platform_admin" | "member";
};

export type AgentRunMcpActorTokenIssuer = (actor: AgentRunMcpActor) => string;

export type ChatMcpActorTokenIssuer = (actor: ChatMcpActor) => string;

function buildCinatraMcpServerTool(
  serverUrl: string,
  authorizationHeader: string,
): LlmMcpServerTool {
  return {
    type: "mcp",
    serverLabel: "cinatra",
    serverUrl,
    headers: { Authorization: authorizationHeader },
    serverDescription:
      "Cinatra enterprise intelligence MCP: read agents, workflows, " +
      "objects/lists/projects, content connectors, cubes, artifact authoring, skills. " +
      "Mutations run via agent dispatch only; no permissions/auth/settings access.",
    allowedTools: null,
    requireApproval: "never",
  };
}

// ---------------------------------------------------------------------------
// Private helper — single-source the OAuth client_credentials token exchange.
// Called by buildLlmMcpServerTool for external-provider → /api/mcp injection.
// ---------------------------------------------------------------------------

async function _exchangeClientCredentialsForAccessToken(
  credentials: { clientId: string; clientSecret: string; scope: string },
  provider: LlmProvider,
): Promise<string | null> {
  const tokenEndpoint = getLocalTokenEndpointUrl(AUTH_BASE_PATH);
  try {
    const basicCredentials = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
    const tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basicCredentials}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: credentials.scope,
        resource: getLocalMcpServerUrl("/api/mcp"),
      }),
    });
    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      throw new Error(`Token endpoint returned ${tokenResponse.status}: ${errorBody}`);
    }
    const tokenData = await tokenResponse.json() as { access_token?: string };
    if (!tokenData.access_token) {
      throw new Error("Token endpoint did not return an access_token");
    }
    return tokenData.access_token;
  } catch (err) {
    console.warn(
      `[mcp-access] token exchange for provider ${provider} failed — skipping`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Build an LlmMcpServerTool for a given LLM provider.
 *
 * Exchanges the stored client_credentials for a short-lived Bearer token via
 * the local OAuth token endpoint, then passes the token as an Authorization
 * header. This is the correct auth flow: the MCP server validates Bearer
 * tokens (not raw client credentials). Returns null if:
 * - No credentials are provisioned for this provider
 * - No public MCP URL is configured
 * - Token exchange fails
 */
export async function buildLlmMcpServerTool(provider: LlmProvider): Promise<LlmMcpServerTool | null> {
  const credentials = getLlmMcpCredentials(provider);
  if (!credentials) {
    return null;
  }

  const serverUrl = getPublicMcpServerUrl();
  if (!serverUrl) {
    return null;
  }

  const accessToken = await _exchangeClientCredentialsForAccessToken(credentials, provider);
  if (!accessToken) {
    return null;
  }

  return buildCinatraMcpServerTool(serverUrl, `Bearer ${accessToken}`);
}

/**
 * Build the Cinatra self-MCP tool for the chat using a delegated human actor
 * token (NOT the machine client_credentials token).
 *
 * `issueActorToken` is injected by the app layer (the chat runner) so this
 * package stays free of `@/` imports. The resulting `type: "mcp"` server
 * reference makes OpenAI's hosted MCP relay the call back to /api/mcp
 * carrying the chat user's identity — see src/lib/chat-mcp-actor-token.ts.
 */
export async function buildLlmMcpServerToolForChat(
  provider: Extract<LlmProvider, "openai" | "anthropic">,
  actor: ChatMcpActor,
  issueActorToken: ChatMcpActorTokenIssuer,
): Promise<LlmMcpServerTool | null> {
  const serverUrl = getPublicMcpServerUrl();
  if (!serverUrl) return null;

  try {
    return buildCinatraMcpServerTool(
      serverUrl,
      `Bearer ${issueActorToken(actor)}`,
    );
  } catch (err) {
    console.warn(
      `[mcp-access] delegated chat token for provider ${provider} failed — skipping cinatra self-MCP`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Build the Cinatra self-MCP tool for a DISPATCHED AGENT RUN using a
 * run-scoped delegated actor token (NOT the machine client_credentials
 * token, NOT the chat-OBO token).
 *
 * Used by `/api/llm-bridge` when WayFlow → bridge resolves the live agent
 * run (`runForPorts.orgId` non-null AND `run.runBy` is still a live member
 * or platform admin). The resulting `type: "mcp"` server reference makes
 * OpenAI's hosted MCP relay the call back to /api/mcp carrying the run
 * owner's identity, the run's org id, AND the run id (audit trail).
 *
 * `issueActorToken` is injected by the app layer
 * (`src/lib/agent-run-mcp-actor-token.ts`) so this package stays
 * `@/`-free.
 *
 * Returns null gracefully if the public MCP URL is unavailable or the
 * token issuer throws (preserves pre-fix machine-token fallback).
 */
export async function buildLlmMcpServerToolForAgentRun(
  provider: Extract<LlmProvider, "openai" | "anthropic">,
  actor: AgentRunMcpActor,
  issueActorToken: AgentRunMcpActorTokenIssuer,
): Promise<LlmMcpServerTool | null> {
  const serverUrl = getPublicMcpServerUrl();
  if (!serverUrl) return null;

  try {
    return buildCinatraMcpServerTool(
      serverUrl,
      `Bearer ${issueActorToken(actor)}`,
    );
  } catch (err) {
    console.warn(
      `[mcp-access] delegated agent-run token for provider ${provider} failed — skipping cinatra self-MCP`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Issues a client_credentials token with scope "a2a:connect" and audience
 * pointing at /api/a2a on the local server. Used by langgraph-execution.ts
 * to populate `a2a_bearer_token` in graphInput so Python child-agent dispatch
 * via A2A is authenticated correctly.
 */
export async function buildA2aBearerToken(provider: LlmProvider = "openai"): Promise<string | null> {
  // When A2A_DEV_BYPASS is set, skip the OAuth exchange entirely.
  // The receiving endpoints (verifyA2AAccessToken, verifyLangGraphBridgeToken) bypass
  // JWT validation for localhost/host.docker.internal requests when this flag is active,
  // so any non-empty sentinel value is accepted.
  if (process.env.A2A_DEV_BYPASS === "true") {
    return "dev-bypass";
  }

  const credentials = getLlmMcpCredentials(provider);
  if (!credentials) return null;

  const serverUrl = getPublicMcpServerUrl();
  if (!serverUrl) return null;

  const tokenEndpoint = getLocalTokenEndpointUrl(AUTH_BASE_PATH);
  try {
    const basicCredentials = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
    const tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basicCredentials}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "a2a:connect",
        resource: getLocalMcpServerUrl("/api/a2a"),
      }),
    });
    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      throw new Error(`A2A token endpoint returned ${tokenResponse.status}: ${errorBody}`);
    }
    const tokenData = await tokenResponse.json() as { access_token?: string };
    if (!tokenData.access_token) throw new Error("A2A token endpoint did not return access_token");
    return tokenData.access_token;
  } catch (err) {
    console.warn(`[mcp-access] A2A token exchange failed — skipping`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Build the array of EXTERNAL MCP server tools — i.e. MCP servers that are
 * NOT the cinatra self-MCP. Currently this is the WordPress MCP adapter.
 * Designed to be extended with additional external MCP servers in the future.
 *
 * Returns an empty array on failure or when no external MCP servers are
 * configured — never throws. The caller is responsible for prepending the
 * cinatra self-MCP (via buildLlmMcpServerTool) so that the MCP injection
 * rule is preserved.
 */
export async function buildExternalMcpServerTools(
  provider: LlmProvider,
): Promise<LlmMcpServerTool[]> {
  try {
    const [wpTools, drupalTools, apifyTools] = await Promise.all([
      buildWordPressMcpServerTools(provider),
      buildDrupalMcpServerTools(provider),
      buildApifyMcpServerTools(provider),
    ]);
    return [...wpTools, ...drupalTools, ...apifyTools];
  } catch (err) {
    console.warn(
      `[mcp-access] buildExternalMcpServerTools(${provider}): failed — returning empty list`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}
