/**
 * LLM MCP access — thin adapter that re-exports credential helpers from
 * @cinatra-ai/mcp-server (the authoritative owner of MCP OAuth credentials)
 * and provides the orchestration-layer buildLlmMcpServerTool function.
 */

import "server-only";

import type { ExtensionToolboxBuildContext } from "@cinatra-ai/sdk-extensions";
import type { LlmProvider, LlmMcpServerTool } from "./types";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import {
  loadExternalMcpToolboxBySlug,
  sanitizeExternalMcpToolboxTools,
} from "@/lib/external-mcp-toolbox-loader.server";
import { buildSingleExternalMcpTool } from "@/lib/external-mcp-registry";
import { buildAllToolboxProviderTools } from "@/lib/llm-toolbox-providers";
import { normalizeMcpServerName } from "./mcp-materializer";
import { getPublicMcpServerUrl, getLlmMcpCredentials, getLocalTokenEndpointUrl, getLocalMcpServerUrl } from "@cinatra-ai/mcp-server/credentials";
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

// Re-export so existing callers don't need to change their imports.
export { getPublicMcpServerUrl, getLlmMcpCredentials, hasLlmMcpAccess, getLlmMcpAccessStatus } from "@cinatra-ai/mcp-server/credentials";

const AUTH_BASE_PATH = "/api/auth";

// ---------------------------------------------------------------------------
// Public MCP URL reachability probe (#1699)
//
// The public MCP base URL is a DB-stored row written once when a tunnel
// existed; nothing ever re-validated it. When the ingress dies (a tailscale
// funnel stops being served, a tunnel process exits), OpenAI does NOT error —
// it silently omits the hosted MCP server from the model's view (200
// completed, no mcp_list_tools item, no 424), so chat loses every Cinatra
// tool with no signal anywhere and the model confabulates an explanation.
// The loud 424 path (planMcpToolListErrorRecovery, #500) never fires.
//
// This probe lets attach sites detect the dead-ingress case BEFORE handing
// the URL to a provider. ANY HTTP response — including 401/405 — proves the
// ingress is live (the MCP endpoint auth-gates POSTs; liveness is all we
// ask); only network-level failures (DNS, connection refused, TLS, timeout)
// count as unreachable. Results are cached briefly so per-turn cost stays
// negligible: a live answer is trusted for a minute, a dead one is re-probed
// sooner so recovery is quick after the operator fixes the tunnel.
// ---------------------------------------------------------------------------

export type PublicMcpReachability =
  | { status: "unconfigured" }
  | { status: "reachable"; url: string }
  | { status: "unreachable"; url: string; reason: string };

const MCP_REACHABILITY_TTL_OK_MS = 60_000;
const MCP_REACHABILITY_TTL_FAIL_MS = 15_000;
const MCP_REACHABILITY_TIMEOUT_MS = 2_500;

let mcpReachabilityCache: { validUntil: number; forUrl: string; result: PublicMcpReachability } | null = null;

/** Test hook — the module-level cache would otherwise leak across tests. */
export function _resetPublicMcpReachabilityCacheForTests(): void {
  mcpReachabilityCache = null;
}

/**
 * Probe the configured public MCP server URL for basic network reachability.
 * Cached (60s live / 15s dead); ~2.5s timeout; never throws.
 */
export async function checkPublicMcpReachability(): Promise<PublicMcpReachability> {
  const url = getPublicMcpServerUrl();
  if (!url) return { status: "unconfigured" };

  const now = Date.now();
  if (mcpReachabilityCache && mcpReachabilityCache.forUrl === url && mcpReachabilityCache.validUntil > now) {
    return mcpReachabilityCache.result;
  }

  let result: PublicMcpReachability;
  try {
    // HEAD keeps the probe body-free; a 405 from a POST-only route is still
    // a live ingress. `redirect: "manual"` so a proxied 3xx also counts
    // without following anywhere.
    await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(MCP_REACHABILITY_TIMEOUT_MS),
    });
    result = { status: "reachable", url };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError"
        ? `no response within ${MCP_REACHABILITY_TIMEOUT_MS}ms`
        : err instanceof Error
          ? ((err.cause as { message?: string } | undefined)?.message ?? err.message)
          : String(err);
    result = { status: "unreachable", url, reason };
  }

  mcpReachabilityCache = {
    forUrl: url,
    validUntil: now + (result.status === "reachable" ? MCP_REACHABILITY_TTL_OK_MS : MCP_REACHABILITY_TTL_FAIL_MS),
    result,
  };
  return result;
}

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
  /**
   * The agent's anchored scope-ceiling CHAIN (see @cinatra-ai/mcp-server/
   * obo-ceiling). Derived at dispatch, persisted on the run, re-derived +
   * containment-checked at mint, then minted into the OBO token. Structurally
   * mirrors the app-layer `AgentRunMcpActor` (agent-run-mcp-actor-token.ts).
   */
  oboCeiling: OboCeilingChain;
  /**
   * The run's CURRENT execution attempt id (`att` claim, cinatra#1939 S3) —
   * threaded from the run row at the bridge so the org-write run authority
   * can refuse stale attempts. Optional; mirrors the app-layer type.
   */
  executionAttemptId?: string;
};

export type AgentRunMcpActorTokenIssuer = (actor: AgentRunMcpActor) => string;

export type ChatMcpActorTokenIssuer = (actor: ChatMcpActor) => string;

/**
 * Server-built inputs for the public-site widget → MCP delegated OBO token
 * (S5, cinatra#1221). Structurally mirrors the app-layer
 * `WidgetMcpActorTokenInput` (src/lib/widget-mcp-actor-token.ts); the issuer is
 * INJECTED from the app layer so this package stays `@/`-free.
 *
 * `platformRole` is deliberately ABSENT — a widget user is floored to `member`
 * at the token mint (the token omits `prole`, the verifier hard-codes it), so
 * there is no way to mint a platform-admin widget token here (G5). The pinned
 * `instanceId` + `kind` ride the token as its FAIL-CLOSED `inst`/`knd` claims,
 * and `jti` is the per-turn nonce the transport turn-binds for replay
 * containment.
 */
export type WidgetMcpActor = {
  userId: string;
  orgId: string;
  instanceId: string;
  kind: "wordpress" | "drupal";
  jti: string;
};

export type WidgetMcpActorTokenIssuer = (actor: WidgetMcpActor) => string;

function buildCinatraMcpServerTool(
  serverUrl: string,
  authorizationHeader: string,
  allowedTools: string[] | null = null,
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
    // `null` (default) = unrestricted, preserving the chat / machine /
    // general-agent-run behavior. A non-null allowlist pins the cinatra
    // self-MCP tool to an explicit tool set (#1214: the in-admin CMS
    // content-editor agent runs are pinned to the MCP-backed CMS primitives so
    // they cannot reach the not-yet-rerouted direct-REST CMS primitives).
    allowedTools,
    approval: "auto_execute",
    // First-party transport classification (llm-providers S2, #1713): the
    // Cinatra self-MCP (/api/mcp) is served over the modern MCP Streamable HTTP
    // transport (verified stateless — no SSE session pinning). Declared
    // explicitly so it is never left as "unknown" and never inferred from URL.
    transport: "streamable-http",
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
 * Build the Cinatra self-MCP tool for the PUBLIC-SITE WIDGET path using a
 * `cinatra.widget.mcp-obo` delegated actor token (NOT the chat-OBO token, NOT
 * the machine client_credentials token) — S5, cinatra#1221.
 *
 * The `/api/assistants/chat` broker-auth branch has already run the full
 * dual-token fail-closed sequence and built a SERVER-VERIFIED widget principal
 * (pinned canonical instance + connector kind). The assistant runtime seam
 * calls this instead of `...ForChat` so the hosted-MCP relay carries the widget
 * OBO token: the MCP transport verifies it to a `delegation: "public_site_widget"`
 * actor → the CLOSED, kind-keyed `delegated-widget` tool policy applies (only the
 * bound kind's `*_content_editor_run`), the write authorizes AS THE END USER
 * against the pinned instance, and platform-admin is floored to `member`. No
 * privilege widening vs. the OLD relay.
 *
 * `issueActorToken` is injected by the app layer
 * (`src/lib/widget-mcp-actor-token.ts`) so this package stays `@/`-free.
 * Returns null gracefully if the public MCP URL is unavailable or the issuer
 * throws (preserves the machine-token fallback — which is DENIED at the widget
 * boundary, so a mint failure fails CLOSED, never opening the chat surface).
 */
export async function buildLlmMcpServerToolForWidget(
  provider: Extract<LlmProvider, "openai" | "anthropic">,
  actor: WidgetMcpActor,
  issueActorToken: WidgetMcpActorTokenIssuer,
): Promise<LlmMcpServerTool | null> {
  const serverUrl = getPublicMcpServerUrl();
  if (!serverUrl) return null;

  try {
    // No tool-level allowlist here: the CLOSED `delegated-widget` tool policy is
    // applied at the MCP transport, keyed off the VERIFIED actor's delegation +
    // kind (packages/mcp-server) — never from a caller-supplied list. Passing an
    // allowlist here would be advisory only and could drift from the authoritative
    // transport policy, so it is intentionally omitted.
    return buildCinatraMcpServerTool(
      serverUrl,
      `Bearer ${issueActorToken(actor)}`,
    );
  } catch (err) {
    console.warn(
      `[mcp-access] delegated widget token for provider ${provider} failed — skipping cinatra self-MCP`,
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
  // #1214: an explicit cinatra self-MCP tool allowlist for this run, or `null`
  // (default) for unrestricted access (the existing general-agent-run
  // behavior). The caller (/api/llm-bridge) passes the in-admin CMS allowlist
  // for content-editor agent runs so they cannot reach the not-yet-rerouted
  // direct-REST CMS primitives; every other agent run stays unrestricted.
  allowedTools: string[] | null = null,
): Promise<LlmMcpServerTool | null> {
  const serverUrl = getPublicMcpServerUrl();
  if (!serverUrl) return null;

  try {
    return buildCinatraMcpServerTool(
      serverUrl,
      `Bearer ${issueActorToken(actor)}`,
      allowedTools,
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
 * Resolve one external-MCP-capable extension record to its injectable tools.
 *
 * First-party extensions ship a toolbox module recorded in the generated
 * manifest loader map (resolved by slug, no package named here); extensions
 * WITHOUT a first-party builder resolve through the `external_mcp_servers`
 * registry by slug (id → label fallback; the registry's connector-scope guard
 * applies and fail-closed drops the tool without an actor frame) — unless the
 * caller opted out of registry injection (`skipRegistryFallback`).
 *
 * Never throws — a failing extension degrades to "no tools from this
 * extension" with a warning, without dropping the other toolboxes.
 */
/** A tool tagged with where it came from — first-party connector toolboxes
 *  and capability providers are "managed"; `external_mcp_servers` registry
 *  rows are "byo". On a normalized-label collision the managed entry wins
 *  (cinatra#2015 S0). */
type TaggedMcpServerTool = { tool: LlmMcpServerTool; origin: "managed" | "byo" };

async function buildToolboxToolsForSlug(
  slug: string,
  provider: LlmProvider,
  skipRegistryFallback: boolean,
  context?: ExtensionToolboxBuildContext,
): Promise<TaggedMcpServerTool[]> {
  try {
    const toolbox = await loadExternalMcpToolboxBySlug(slug);
    if (toolbox) {
      return sanitizeExternalMcpToolboxTools(slug, await toolbox.buildTools(provider, context)).map(
        (tool) => ({ tool, origin: "managed" as const }),
      );
    }
    if (skipRegistryFallback) return [];
    const registryTool = await buildSingleExternalMcpTool(slug);
    if (registryTool) return [{ tool: registryTool, origin: "byo" }];
    console.warn(
      `[mcp-access] external-MCP toolbox extension "${slug}" has no first-party builder and no external_mcp_servers row — injecting nothing for it`,
    );
    return [];
  } catch (err) {
    console.warn(
      `[mcp-access] external-MCP toolbox "${slug}" failed — injecting nothing for it`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Collision scope is PER ENTRY (cinatra#2015 S0 — was exact-label first-wins
 * with no detection): duplicate NORMALIZED labels keep exactly one tool — the
 * first managed one if any, else the first seen — and every suppressed entry
 * is audit-warned individually. One colliding row never drops the batch.
 */
function resolveInjectionCollisions(
  tagged: readonly TaggedMcpServerTool[],
): LlmMcpServerTool[] {
  const winners = new Map<string, TaggedMcpServerTool>();
  const suppressed: Array<{ loser: TaggedMcpServerTool; winner: TaggedMcpServerTool }> = [];
  for (const entry of tagged) {
    const key = normalizeMcpServerName(entry.tool.serverLabel);
    const incumbent = winners.get(key);
    if (!incumbent) {
      winners.set(key, entry);
      continue;
    }
    if (incumbent.origin !== "managed" && entry.origin === "managed") {
      winners.set(key, entry);
      suppressed.push({ loser: incumbent, winner: entry });
    } else {
      suppressed.push({ loser: entry, winner: incumbent });
    }
  }
  for (const { loser, winner } of suppressed) {
    console.warn(
      `[mcp-access] external-MCP server "${loser.tool.serverLabel}" (${loser.origin}) suppressed — ` +
        `its label collides with "${winner.tool.serverLabel}" (${winner.origin}); the rest of the batch injects.`,
    );
  }
  const out: LlmMcpServerTool[] = [];
  for (const entry of tagged) {
    if (winners.get(normalizeMcpServerName(entry.tool.serverLabel)) === entry) {
      out.push(entry.tool);
    }
  }
  return out;
}

export type BuildExternalMcpServerToolsOptions = {
  /**
   * When true, marker-bearing extensions WITHOUT a first-party builder are
   * NOT resolved through the `external_mcp_servers` registry. Mirrors the
   * `skipExternalMcpRegistry` flag of the legacy always-inject path so a
   * caller that opts out of registry injection cannot reach registry rows
   * through the manifest fallback either.
   */
  skipRegistryFallback?: boolean;
  /**
   * Host-built, identity-free toolbox build context (cinatra#2019 S4) —
   * WHERE this injection is being assembled (surface) and, on run surfaces,
   * WHICH connector instance the run is pinned to. Threaded verbatim into
   * every first-party toolbox's `buildTools(provider, context)`; surface-
   * gating toolboxes treat an ABSENT context as "emit nothing" (fail-closed
   * on unwidened callers). Existing one-arg toolboxes ignore it — passing a
   * context never changes their output. DELIBERATELY NOT threaded into the
   * `llm-toolbox` capability-provider path (`buildAllToolboxProviderTools`):
   * those providers do no per-instance site injection.
   */
  context?: ExtensionToolboxBuildContext;
};

/**
 * Build the array of EXTERNAL MCP server tools — i.e. MCP servers that are
 * NOT the cinatra self-MCP.
 *
 * MANIFEST-DRIVEN: the set of contributing extensions is the generated
 * extension manifest's records carrying the `providesExternalMcpToolbox`
 * capability marker — adding/removing an external-MCP-capable extension
 * requires no edit here. Builds run concurrently per extension; results are
 * flattened in the manifest's deterministic (packageName-sorted) order.
 *
 * REGISTRATION-DRIVEN (appended): every `llm-toolbox` capability provider a
 * serverEntry registered at activation contributes its tools as well.
 *
 * Duplicate normalized labels resolve PER ENTRY via
 * `resolveInjectionCollisions` — managed connector entries win over BYO
 * registry rows, every suppressed entry is audit-warned, and one colliding
 * row never drops the rest of the batch (cinatra#2015 S0).
 *
 * Returns an empty array on failure or when no external MCP servers are
 * configured — never throws. The caller is responsible for prepending the
 * cinatra self-MCP (via buildLlmMcpServerTool) so that the MCP injection
 * rule is preserved.
 */
export async function buildExternalMcpServerTools(
  provider: LlmProvider,
  options: BuildExternalMcpServerToolsOptions = {},
): Promise<LlmMcpServerTool[]> {
  try {
    const slugs = Object.values(STATIC_EXTENSION_MANIFEST)
      .filter((record) => record.providesExternalMcpToolbox)
      .map((record) => record.packageName.split("/")[1]);
    const [manifestToolLists, capabilityTools] = await Promise.all([
      Promise.all(
        slugs.map((slug) =>
          buildToolboxToolsForSlug(slug, provider, options.skipRegistryFallback === true, options.context),
        ),
      ),
      // Registration-driven: every `llm-toolbox` capability provider (apify
      // today) ALSO contributes its tools to the legacy always-inject set. A
      // connector resolving through BOTH paths (manifest marker + capability
      // provider) yields identical tool definitions; collision resolution
      // below keeps the managed one.
      buildAllToolboxProviderTools(provider),
    ]);
    return resolveInjectionCollisions([
      ...manifestToolLists.flat(),
      ...capabilityTools.map((tool) => ({ tool, origin: "managed" as const })),
    ]);
  } catch (err) {
    console.warn(
      `[mcp-access] buildExternalMcpServerTools(${provider}): failed — returning empty list`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}
