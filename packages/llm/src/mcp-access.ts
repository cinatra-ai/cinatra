/**
 * LLM MCP access — thin adapter that re-exports credential helpers from
 * @cinatra-ai/mcp-server (the authoritative owner of MCP OAuth credentials)
 * and provides the orchestration-layer buildLlmMcpServerTool function.
 */

import "server-only";

import type { ExtensionToolboxBuildContext } from "@cinatra-ai/sdk-extensions";
import type { LlmProvider, LlmMcpServerTool, LlmTool } from "./types";
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

// ---------------------------------------------------------------------------
// State-derived self-MCP catalog for the chat surface.
//
// WHY DERIVED AND NOT LISTED. Cinatra is extensible: a user installs
// connectors and each connector brings its own MCP primitives. Any fixed table
// of primitive names is wrong the moment a connector ships one the table does
// not know, because an unlisted primitive is simply invisible. So the catalog
// is COMPUTED per turn from what this instance can actually serve, filtered by
// what this actor is actually authorized to use.
//
// WHAT NARROWS THE CATALOG, in order:
//   1. HOST ADMISSION. The authoritative delegated-chat policy decides whether
//      a name is reachable at all. It stays the only thing that can ADMIT.
//   2. DECLARED CLASS. A registration may declare how it means to be used on
//      the chat surface. A declaration can only ever NARROW: a connector
//      self-classifying is not authorization, so a declaration the host has
//      not admitted grants nothing, and an absent declaration changes nothing.
//   3. CAPABILITY AVAILABILITY. A primitive behind a capability that this
//      actor has no authorized connection for is not offered, because offering
//      it only buys a failed call and the tokens to describe it.
//
// WHY THIS IS STILL CACHE-FRIENDLY. The result changes with package,
// connection and verified-actor authorization state. It does not change with
// the question being asked, so for one actor in one state the bytes are
// stable. That is the property the prefix needs; it is not a claim that the
// provider reuses the prefix today, which the per-turn bearer token in the
// tool block still prevents.
//
// AUTHORITY IS UNCHANGED. This is an advisory narrowing hint on the provider
// request. The authoritative gate stays server-side at MCP runtime server
// construction: registration-time filtering plus a call-time guard keyed off
// the verified actor. A provider that ignores the hint changes nothing about
// what is callable, and nothing here can widen the perimeter.
// ---------------------------------------------------------------------------

/**
 * How a registration means its primitive to be used on the delegated chat
 * surface. Structural only. Never sufficient authorization on its own.
 *
 * RE-EXPORTED, not redeclared: this is the SDK's author-facing enum, the same
 * one both registration paths carry (`HostMcpToolRegistration.delegatedChat`
 * and the manifest-discovered config's `delegatedChat`). A second copy here
 * could drift from the enum the host actually validates, and a resolver that
 * disagreed with the registration boundary about what "dispatch" means would
 * be a security bug, not a typo.
 */
export type { DelegatedChatToolClass } from "@cinatra-ai/sdk-extensions";

/**
 * The chat-eligible classes. A declaration outside this set narrows to nothing,
 * which covers BOTH an explicit `"none"` and any value that is not a valid
 * class at all — the same fail-closed-toward-narrowing reading the host's
 * `normalizeDelegatedChatToolClass` applies, since an unreadable declaration
 * must never be re-read as the NEUTRAL "undeclared".
 *
 * DELIBERATELY A LOCAL MIRROR, not an import of the policy's runtime helper.
 * This module sits on a hot import path (`@cinatra-ai/llm/registry` reaches it,
 * and three workspace packages stub the `@cinatra-ai/mcp-server` barrel in
 * their test resolution), so a new runtime cross-package edge here is a
 * resolution liability for a rule that is four strings long. The authority
 * remains `delegated-chat-tool-policy.ts`; `__tests__/delegated-chat-class-drift.test.ts`
 * pins this set against it at both type and value level, so the mirror cannot
 * drift silently.
 */
const CHAT_ELIGIBLE_CLASSES: ReadonlySet<string> = new Set(["read", "discovery", "dispatch"]);

/** One primitive this instance can currently serve. */
export type ServableChatPrimitive = {
  name: string;
  /**
   * The class the registration declared, when it declared one. Absent means
   * undeclared, which is neutral: host admission alone decides.
   */
  declaredClass?: string | null;
  /**
   * The capability whose availability gates this primitive, when one does.
   * Absent means the primitive is not connection-gated.
   */
  capabilityKey?: string | null;
};

/**
 * Everything the resolver needs, injected. This module is `@/`-free by rule,
 * so the host resolves state and passes it in, exactly as it already injects
 * the actor-token issuer.
 */
export type ChatMcpCatalogState = {
  /** Primitives currently registered and servable on this instance. */
  servable: readonly ServableChatPrimitive[];
  /** Host admission. The only predicate that may admit a name. */
  isHostApproved: (name: string) => boolean;
  /**
   * Whether the VERIFIED actor holds an authorized connection for a
   * capability. Called only for primitives that declare a capability key.
   */
  isCapabilityAvailable: (capabilityKey: string) => boolean;
};

/**
 * Derive the advisory allowlist for one turn.
 *
 * Deduplicated and lexicographically sorted, so the same instance state and
 * the same actor authorization always produce a byte-identical array whatever
 * order the registry enumerated in.
 */
export function resolveChatMcpAllowedTools(state: ChatMcpCatalogState): string[] {
  const admitted = new Set<string>();
  for (const primitive of state.servable) {
    const name = primitive.name;
    if (typeof name !== "string" || name.length === 0) continue;
    // 1. Host admission is the only thing that admits.
    if (!state.isHostApproved(name)) continue;
    // 2. A declaration may narrow, never widen. Note this runs strictly AFTER
    //    host admission above, which is what makes it structurally impossible
    //    for a declaration to widen: an unadmitted name never reaches here.
    const declared = primitive.declaredClass;
    if (declared != null && !CHAT_ELIGIBLE_CLASSES.has(declared)) continue;
    // 3. A connection-gated primitive needs an authorized connection.
    const capability = primitive.capabilityKey;
    if (capability != null && capability !== "" && !state.isCapabilityAvailable(capability)) {
      continue;
    }
    admitted.add(name);
  }
  return [...admitted].sort();
}

/**
 * Server-built inputs for the public-site widget → MCP delegated OBO token
 * (S5, cinatra#1221). Structurally mirrors the app-layer
 * `WidgetMcpActorTokenInput` (src/lib/widget-mcp-actor-token.ts); the issuer is
 * INJECTED from the app layer so this package stays `@/`-free.
 *
 * `platformRole` is the end user's REAL tier since cinatra#2674 (epic #2564
 * S8e). It used to be deliberately ABSENT so the token could floor a widget user
 * to `member`; that floor existed because the embedding site possessed the
 * widget bearer, and S8e ends that possession. The value is resolved server-side
 * at the chat route from the user record — the browser and the CMS have no
 * channel to it — and OMITTING it still means `member`, so a caller that does
 * not set it can only ever narrow. The pinned `instanceId` + `kind` ride the
 * token as its FAIL-CLOSED `inst`/`knd` claims, `jti` is the per-turn nonce, and
 * `parentJti`/`turnRunId` are the two seals (cinatra#2687) the host's
 * authorization layer checks against the live sign-in and the live turn.
 */
export type WidgetMcpActor = {
  userId: string;
  orgId: string;
  instanceId: string;
  kind: "wordpress" | "drupal";
  jti: string;
  /** The `jti` of the `cwu_` widget token whose sign-in the turn ran under. */
  parentJti: string;
  /** The AG-UI run id of the turn this token is minted for. */
  turnRunId: string;
  /**
   * cinatra#2577 (epic #2564 S8d) — did the `cwu_` that authorized this turn
   * carry the `lifecycle.read` grant? Passed straight through to the injected
   * issuer, which mints it as the token's `lcr` claim (and mints nothing when
   * it is false, so the no-grant token stays byte-identical to a pre-S8d one).
   * This package neither derives nor interprets it.
   */
  lifecycleRead: boolean;
  /**
   * cinatra#2674 (epic #2564 S8e) — the end user's REAL platform tier, resolved
   * server-side from the user record. Optional at the type level because
   * omitting it means `member`: a caller that does not set it can only narrow,
   * never elevate.
   */
  platformRole?: "platform_admin" | "member";
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
  // The instance and actor state the catalog is derived from. Omitting it
  // leaves the reference unrestricted, which is the pre-existing behavior and
  // stays safe because the authoritative transport gate still decides what is
  // callable. The host passes state whenever it can resolve it.
  options: { catalogState?: ChatMcpCatalogState } = {},
): Promise<LlmMcpServerTool | null> {
  const serverUrl = getPublicMcpServerUrl();
  if (!serverUrl) return null;

  try {
    const derived = options.catalogState
      ? resolveChatMcpAllowedTools(options.catalogState)
      : null;
    return buildCinatraMcpServerTool(
      serverUrl,
      `Bearer ${issueActorToken(actor)}`,
      // An EMPTY derivation must never be sent: both adapters read an empty
      // allowlist as unrestricted, so it would widen rather than narrow. An
      // empty result also means the resolver found nothing admissible, which
      // is a host state bug. Fall back to unrestricted and let the
      // authoritative gate hold rather than encode a bug as a hint.
      derived && derived.length > 0 ? derived : null,
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
 * The FIRST-PARTY server label (`buildCinatraMcpServerTool`). Reserved: no
 * external MCP server may present it.
 *
 * cinatra#2565 — the label is now a TRUST SIGNAL, not just a display string.
 * The lifecycle typed-view producer accepts a card-minting envelope only from
 * the (serverLabel === "cinatra", allowlisted tool) tuple, and a provider echoes
 * back whatever label its server was injected with. The cinatra self-MCP tool is
 * PREPENDED by the caller and so never entered this collision pass — meaning an
 * external toolbox that named itself "cinatra" would have been injected
 * ALONGSIDE the real one and could impersonate it on the way back. Reserving the
 * label closes that at the injection boundary, where it belongs, rather than
 * asking every consumer of a serverLabel to re-derive trust.
 */
const RESERVED_FIRST_PARTY_SERVER_LABEL = "cinatra";

/**
 * Drop every tool claiming the reserved first-party label, loudly.
 *
 * Applied at EVERY external-tool ingress (this module's always-inject pass and
 * both of `registry.ts`'s assembly paths) rather than at one of them: the
 * declared-toolbox-id path assembles its tools without this module's collision
 * pass, so a guard living only here would leave that door open. The real
 * self-MCP tool is added by its own resolver and never flows through here.
 *
 * The comparison is on the NORMALIZED label so variants ("Cinatra", "cinatra-",
 * " CINATRA ") are dropped too — deliberately BROADER than the exact-match
 * acceptance the lifecycle producer performs, so the two can never disagree in
 * the direction that admits an impostor.
 */
export function withoutReservedFirstPartyLabelTools(
  tools: readonly LlmMcpServerTool[],
  where: string,
): LlmMcpServerTool[] {
  const kept: LlmMcpServerTool[] = [];
  for (const tool of tools) {
    if (
      normalizeMcpServerName(tool.serverLabel) === RESERVED_FIRST_PARTY_SERVER_LABEL
    ) {
      console.warn(
        `[mcp-access] external-MCP server "${tool.serverLabel}" (${where}) DROPPED — ` +
          `"${RESERVED_FIRST_PARTY_SERVER_LABEL}" is the reserved first-party self-MCP label; ` +
          `the rest of the batch injects.`,
      );
      continue;
    }
    kept.push(tool);
  }
  return kept;
}

/**
 * Collision scope is PER ENTRY (cinatra#2015 S0 — was exact-label first-wins
 * with no detection): duplicate NORMALIZED labels keep exactly one tool — the
 * first managed one if any, else the first seen — and every suppressed entry
 * is audit-warned individually. One colliding row never drops the batch.
 *
 * An entry claiming the RESERVED first-party label is dropped outright (loudly)
 * before collisions are considered — it can never win, and it can never be the
 * incumbent another entry loses to.
 */
function resolveInjectionCollisions(
  tagged: readonly TaggedMcpServerTool[],
): LlmMcpServerTool[] {
  const admissible = tagged.filter(
    (entry) =>
      withoutReservedFirstPartyLabelTools([entry.tool], entry.origin).length === 1,
  );
  const winners = new Map<string, TaggedMcpServerTool>();
  const suppressed: Array<{ loser: TaggedMcpServerTool; winner: TaggedMcpServerTool }> = [];
  for (const entry of admissible) {
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
  for (const entry of admissible) {
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

// ---------------------------------------------------------------------------
// Canonical cacheable-prefix projection (cinatra#2771).
//
// WHY A PROJECTION AND NOT AN ASSERTION. Prompt caching is a PREFIX MATCH: a
// provider reuses the longest byte-identical head of a request, so a single
// byte that moves per turn stops every cache read after that point. "Is our
// prefix stable?" is therefore a question about BYTES, and the honest way to
// ask it is to reduce a turn to exactly the bytes that are supposed to be
// stable and compare two turns' reductions. That is this function.
//
// WHAT IT DELIBERATELY DROPS, and why each is not a defect being hidden:
//   • CREDENTIAL MATERIAL: `headers` / `authorization` on any MCP tool. These
//     carry a freshly minted, wall-clock-stamped bearer token. They must never
//     be written to a log, a snapshot or a test fixture, so the projection
//     zeroes them by construction rather than trusting a caller to redact.
//   • CONVERSATION INPUT: `messages`. It varies by definition and sits after
//     the prefix, so it is not part of the question.
//
// WHAT IT KEEPS AND NORMALIZES: the system text and the tool block, which are
// the two things a provider actually renders ahead of the conversation. Tools
// are projected to a stable identity per kind and SORTED, so a tool set that
// differs only in registration order (extension capability providers iterate a
// Map in insertion order, which is boot-dependent) projects identically.
//
// READING THE RESULT, the important caveat. A stable projection proves the
// content WE control is stable. It does NOT prove the wire prefix is stable,
// because the projection excludes exactly the credential material that today
// changes on every turn. Treat a stable projection as a necessary condition,
// never as evidence of a cache hit; the sufficient evidence is
// `cached_input_tokens` on the usage row.
// ---------------------------------------------------------------------------

/** The reduced, comparable form of one turn's intended cacheable prefix. */
export type CacheablePrefixProjection = {
  /** The system text exactly as it would be rendered, or `""` when absent. */
  system: string;
  /**
   * One stable identity line per tool, sorted. Credential material is never
   * present. The shape is `<kind>:<identity>` plus, for an MCP reference, the
   * sorted allowlist that narrows it.
   */
  tools: string[];
};

function projectToolIdentity(tool: LlmTool): string {
  switch (tool.type) {
    case "mcp": {
      // `serverUrl` is an origin+path the operator configured, never a secret,
      // and it is load-bearing for identity: the same label pointed at a
      // different host is a different tool block.
      const allowed = tool.allowedTools ? [...tool.allowedTools].sort() : null;
      const narrowing = allowed ? `allowed=${allowed.join(",")}` : "allowed=*";
      return `mcp:${tool.serverLabel}:${tool.serverUrl}:${narrowing}`;
    }
    case "web_search":
      return "web_search:";
    case "container_skills": {
      const t = tool as { skills?: Array<{ skillId?: string; version?: string }> };
      const skills = (t.skills ?? [])
        .map((s) => `${s.skillId ?? ""}@${s.version ?? ""}`)
        .sort();
      return `container_skills:${skills.join(",")}`;
    }
    default: {
      // Function, shell and sandbox tools are identified by their model-facing
      // name. Anything without one still projects deterministically by kind.
      const named = tool as { type: string; name?: string };
      return `${named.type}:${named.name ?? ""}`;
    }
  }
}

/**
 * Reduce a turn's system text and tool block to the canonical projection.
 *
 * Pure and total: it never throws, never reads a clock, and never returns
 * credential material, so it is safe to call from a test, a gate or a
 * measurement script.
 */
export function projectCacheablePrefix(input: {
  system?: string;
  tools?: LlmTool[];
}): CacheablePrefixProjection {
  return {
    system: input.system ?? "",
    tools: (input.tools ?? []).map(projectToolIdentity).sort(),
  };
}

/**
 * A stable string form of the projection, for byte-equality comparison across
 * turns and for recording in evidence.
 */
export function serializeCacheablePrefixProjection(
  projection: CacheablePrefixProjection,
): string {
  return JSON.stringify(projection, null, 2);
}
