import { AsyncLocalStorage } from "node:async_hooks";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LinkIcon } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { AccountView, AuthView } from "@daveyplate/better-auth-ui";
import type { Auth } from "better-auth";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { accountViewPaths, authViewPaths } from "@daveyplate/better-auth-ui/server";
import { createAuthClient as createServerAuthClient } from "better-auth/client";
import {
  buildMcpAuthPlugins,
  DEFAULT_MCP_SCOPES,
  CLI_SCOPES,
  type McpAuthPlugins,
  type McpAuthPluginsOptions,
} from "./auth-plugins";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import {
  createMcpRuntimeServer,
  type McpRuntimeToolServer,
} from "./runtime-server";
import {
  mcpRequestContextStorage,
  type DelegatedMcpActor,
} from "./request-context";
import { buildMcpHandshakeUrls } from "./handshake-urls";
import { McpAuthFlowBridge } from "./components/mcp-auth-flow-bridge";
import { McpAuthUiProvider } from "./components/mcp-auth-ui-provider";
import { McpClientDetailManager, McpClientsDashboard, type OAuthClientRecord } from "./components/mcp-client-manager";
import { McpCheckResultModal } from "./components/mcp-check-result-modal";
import { McpConsentScreen } from "./components/mcp-consent-screen";
import { writeMcpServerLogFile } from "@/lib/mcp-logging";
import { betterAuthPool } from "@/lib/better-auth-db";
import { readServiceAccountByClientId } from "./service-accounts";
import { resolveActorIdentity, resolveOrgRoleFromMembership } from "./actor-identity";
import { isDelegatedChatMcpToolAllowed } from "./delegated-chat-tool-policy";
import {
  isTrustedDevHost,
  parseTrustedHosts,
  shouldGrantDevAdminBypass,
  urlRequestHost,
} from "./dev-admin-bypass";
import { PageHeader } from "@/components/page-header";
import { getLlmMcpCredentials, getLlmMcpAccessStatus, writeLlmMcpCredentials, LLM_BLOCKED_TOOL_PATTERNS, getLocalMcpServerUrl, getPublicMcpServerUrl, getTrustedTokenOrigins } from "./llm-credentials";
import { z } from "zod";

const DEFAULT_SCOPES = ["openid", "profile", "email", "offline_access", "mcp:connect"] as const;
const SELF_MCP_CLIENT_ID = "cinatra-app-mcp-client";
const SELF_MCP_CLIENT_NAME = "Cinatra App MCP Client";
const SELF_MCP_CLIENT_SCOPE = DEFAULT_SCOPES.join(" ");

type BetterAuthLike = {
  api: object;
};

type SessionLike = {
  user: {
    email?: string | null;
    role?: string | null;
  };
} & Record<string, unknown>;

export type CreateMcpServerAuthPluginsOptions = {
  authBasePath?: string;
  mcpBasePath?: string;
  /** Human-facing admin pages (overview, OAuth client management). */
  adminBasePath?: string;
  /** OAuth machine-flow pages (auth / account / consent) advertised to external MCP clients. */
  handshakeBasePath?: string;
  scopes?: readonly string[];
  /**
   * Additional base path(s) whose `<origin>/<path>` URLs (local + public)
   * become valid token audiences alongside the MCP base path. eng#231 adds
   * `/api/cli` so an authorize with `resource=<origin>/api/cli` mints a JWT
   * bound to `aud=<origin>/api/cli` — a DEDICATED audience the CLI verifier
   * pins (reciprocal isolation from the `/api/mcp` audience).
   */
  extraAudienceBasePaths?: readonly string[];
  /**
   * Scopes EXCLUDED from the DCR default-scope set. A client that does not
   * EXPLICITLY request these never silently receives them (eng#231 keeps the
   * `cli:*` scopes out of DCR defaults). When omitted, the DCR default is the
   * full `scopes` list (today's behaviour).
   */
  clientRegistrationDefaultScopes?: readonly string[];
  /**
   * Scopes a DCR client MAY request at registration. eng#231 keeps `cli:*`
   * here (so the first-party CLI can register with them) — the real authority
   * boundary is the verified-subject platform-admin gate, not this list.
   * When omitted, defaults to the full `scopes` list (today's behaviour).
   */
  clientRegistrationAllowedScopes?: readonly string[];
};

export type CreateMcpServerMountOptions = {
  auth: BetterAuthLike;
  getSession: () => Promise<SessionLike | null>;
  authBasePath?: string;
  mcpBasePath?: string;
  registerCapabilities?: (server: McpRuntimeToolServer) => void | Promise<void>;
  readSettings?: () => Promise<Partial<McpServerSettings> | null> | Partial<McpServerSettings> | null;
  /** Human-facing admin pages (overview, OAuth client management). */
  adminBasePath?: string;
  /** OAuth machine-flow pages (auth / account / consent) advertised to external MCP clients. */
  handshakeBasePath?: string;
  reagentName?: string;
  scopes?: readonly string[];
  serverName?: string;
  serverVersion?: string;
  serverInstructions?: string;
  serverExperimental?: Record<string, object>;
  writeSettings?: (settings: McpServerSettings) => Promise<void> | void;
  /**
   * Returns the list of LLM provider IDs that have MCP credentials configured
   * (e.g. ["openai", "anthropic"]). Used to populate the provider selector on
   * the connectivity check button. Optional — omitting it hides the selector.
   */
  readConfiguredLlmProviders?: () => Promise<string[]>;
  /**
   * In-process run-context registry callback. Called by the transport handler
   * to retrieve run context (runId, agentId, packageVersion, agentSpecVersion)
   * set by the bridge route before each LLM step. Primary mechanism for OpenAI
   * MCP calls (which strip X-Cinatra-* headers). Optional — callers without
   * agent run-context propagation omit it.
   */
  getRunContext?: (key: string) => { runId?: string; agentId?: string; packageVersion?: string; agentSpecVersion?: string } | undefined;
  /**
   * Optional app-layer verifier for delegated on-behalf-of actor tokens.
   * Packages must not import the Next app layer directly; the
   * route mount (src/lib/mcp-server.ts) wires this callback so hosted MCP
   * calls relayed from the chat (via OpenAI's MCP infra) authenticate as the
   * human chat user instead of falling back to an OAuth client_credentials
   * machine actor. Returns the resolved human actor or null when the auth
   * header is not a valid delegated token (any other bearer falls through to
   * the normal verifyMcpAccessToken path).
   */
  verifyDelegatedActorToken?: (input: {
    authHeader: string | null;
    request: Request;
    expectedAudience: string;
    expectedIssuer: string;
  }) => DelegatedMcpActor | null | Promise<DelegatedMcpActor | null>;
};

export type McpServerSettings = {
  publicBaseUrl: string | null;
  // Surfaces "tailscale-auto" URLs minted by `cinatra clone start`
  // via the Nango-stored OAuth client, plus "tailscale-funnel" URLs
  // from the env-var-based sidecar.
  publicBaseUrlSource: "manual" | "tailscale-auto" | "tailscale-funnel" | "unknown";
  selfClient: null | {
    clientId: string;
    clientSecret: string | null;
    clientName: string;
    scope: string;
    tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
    grantTypes: string[];
    createdAt: string;
    updatedAt: string;
    managedBy: "cli" | "manual";
  };
  updatedAt: string | null;
};

type OAuthClientMutationResponse = OAuthClientRecord & {
  client_secret?: string;
};

// Strip trailing "/" via a LINEAR char-index scan. The anchored greedy
// `/\/+$/` is flagged polynomial-ReDoS on slash-heavy input
// (CodeQL js/polynomial-redos); this mirrors the trim already used in
// mcp-public-base-url-shape.mjs and is O(n) with no backtracking.
function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return value.slice(0, end);
}

function normalizePath(path: string | undefined, fallback: string) {
  const value = (path ?? fallback).trim();
  if (!value) {
    return fallback;
  }

  return value.startsWith("/")
    ? trimTrailingSlash(value) || "/"
    : `/${trimTrailingSlash(value)}`;
}

function normalizeOptionalUrl(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    // Origin-only — getPublicMcpServerUrl() appends /api/mcp on read, so a
    // stored URL with a path would yield e.g. https://h/api/mcp/api/mcp.
    if (url.pathname !== "/" && url.pathname !== "") {
      return null;
    }
    url.hash = "";
    url.search = "";
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function defaultMcpServerSettings(): McpServerSettings {
  return {
    publicBaseUrl: null,
    publicBaseUrlSource: "unknown",
    selfClient: null,
    updatedAt: null,
  };
}

function normalizeMcpServerSettings(value: Partial<McpServerSettings> | null | undefined): McpServerSettings {
  const defaults = defaultMcpServerSettings();
  // Honor every source EXCEPT "cli". "cli" was the retired cloudflared quick
  // tunnel — that process no longer runs, so a "cli" URL is dead. Every other
  // live source is preserved on read so the dev tab can distinguish
  // operator-pasted (`"manual"`) from auto-provisioned
  // (`"tailscale-auto"`) from env-var-provided
  // (`"tailscale-funnel"`).
  // Runtime DB rows can carry unrecognized source strings ("cli", "external", …)
  // outside the narrowed McpServerSettings type, so compare against the
  // raw string.
  const rawSource = value?.publicBaseUrlSource as string | undefined;
  const isCliSource = rawSource === "cli";
  const normalizedUrl = isCliSource ? null : normalizeOptionalUrl(value?.publicBaseUrl);
  const preservedSource: McpServerSettings["publicBaseUrlSource"] =
    rawSource === "tailscale-auto" || rawSource === "tailscale-funnel"
      ? rawSource
      : "manual";
  return {
    publicBaseUrl: normalizedUrl,
    publicBaseUrlSource: normalizedUrl ? preservedSource : defaults.publicBaseUrlSource,
    selfClient:
      value?.selfClient &&
      typeof value.selfClient === "object" &&
      typeof value.selfClient.clientId === "string" &&
      value.selfClient.clientId.length > 0 &&
      typeof value.selfClient.clientName === "string" &&
      typeof value.selfClient.scope === "string" &&
      typeof value.selfClient.createdAt === "string" &&
      typeof value.selfClient.updatedAt === "string"
        ? {
            clientId: value.selfClient.clientId,
            clientSecret:
              typeof value.selfClient.clientSecret === "string" && value.selfClient.clientSecret.length > 0
                ? value.selfClient.clientSecret
                : null,
            clientName: value.selfClient.clientName,
            scope: value.selfClient.scope,
            tokenEndpointAuthMethod:
              value.selfClient.tokenEndpointAuthMethod === "none" ||
              value.selfClient.tokenEndpointAuthMethod === "client_secret_post"
                ? value.selfClient.tokenEndpointAuthMethod
                : "client_secret_basic",
            grantTypes: Array.isArray(value.selfClient.grantTypes)
              ? value.selfClient.grantTypes.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
              : [],
            createdAt: value.selfClient.createdAt,
            updatedAt: value.selfClient.updatedAt,
            managedBy: value.selfClient.managedBy === "manual" ? "manual" : "cli",
          }
        : defaults.selfClient,
    updatedAt:
      typeof value?.updatedAt === "string" && value.updatedAt.trim().length > 0 ? value.updatedAt.trim() : defaults.updatedAt,
  };
}

function metadataPathFor(resourcePath: string) {
  return `/.well-known/oauth-protected-resource${resourcePath === "/" ? "" : resourcePath}`;
}

function issuerMetadataPathFor(authBasePath: string, prefix: string) {
  const suffix = authBasePath === "/" ? "" : authBasePath;
  return `${prefix}${suffix}`;
}

function combineOriginAndPath(origin: string, path: string) {
  return `${origin}${path === "/" ? "" : path}`;
}

function inferRequestOrigin(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return new URL(request.url).origin;
}

function inferLocalAppOrigin() {
  return normalizeOptionalUrl(
    process.env.BETTER_AUTH_URL ??
      process.env.NEXT_PUBLIC_BETTER_AUTH_URL ??
      "http://localhost:3000",
  ) ?? "http://localhost:3000";
}

function isLocalhostHostname(hostname: string): boolean {
  // Strip port suffix (e.g. "localhost:3001" → "localhost") before comparing.
  const host = hostname.includes(":") ? hostname.slice(0, hostname.lastIndexOf(":")) : hostname;
  // host.docker.internal is the Docker Desktop hostname for the host machine —
  // treated as a local connection (network-level trust, same as loopback).
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "host.docker.internal";
}

/**
 * Returns true when the request reaches the server directly without an external reverse-proxy.
 * Cloudflare and other public proxies set x-forwarded-host to a non-loopback hostname, so they
 * are NOT considered local. Turbopack's dev server sets x-forwarded-host to "localhost:<port>",
 * which is still a loopback address and is treated as local.
 */
function isLocalhostRequest(request: Request): boolean {
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost && !isLocalhostHostname(forwardedHost)) {
    return false;
  }
  const hostname = new URL(request.url).hostname;
  return isLocalhostHostname(hostname);
}

/**
 * Request-level trust check for the MCP dev-admin bypass.
 *
 * Returns true when the request hits a host the operator has declared
 * trusted (loopback by default, plus any hostname in
 * `CINATRA_MCP_DEV_TRUSTED_HOSTS`) AND the env opt-ins are set AND we are
 * not in production. Used ONLY by the OAuth-skip + admin-bypass paths.
 * All other `isLocalhostRequest` call sites (actor identity fallback, A2A
 * dev-bypass org fallback) keep strict loopback semantics.
 */
function isTrustedDevHostRequest(request: Request): boolean {
  return isTrustedDevHost({
    nodeEnv: process.env.NODE_ENV,
    envBypassFlag: process.env.CINATRA_MCP_DEV_ADMIN_BYPASS,
    trustedHostsEnv: process.env.CINATRA_MCP_DEV_TRUSTED_HOSTS,
    urlHost: urlRequestHost(request.url),
    // Pass the RAW `x-forwarded-host` header value (or null when absent).
    // The helper distinguishes "absent" (veto inactive) from "present but
    // malformed" (veto rejects) — collapsing them here would silently
    // disable the veto against malformed-spoof headers.
    forwardedHostRaw: request.headers.get("x-forwarded-host"),
  });
}

/**
 * Emits a one-time loud startup warning when the dev-admin bypass is
 * active and a non-empty `CINATRA_MCP_DEV_TRUSTED_HOSTS`
 * allowlist is configured. Lists each normalized host so misconfigured
 * entries (typos, scheme prefixes that won't match) are visible.
 *
 * Skipped entirely in production builds; never logs per-request to keep
 * server log noise bounded.
 */
let devTrustedHostsWarningEmitted = false;
function emitDevTrustedHostsWarningOnce(): void {
  if (devTrustedHostsWarningEmitted) return;
  devTrustedHostsWarningEmitted = true;
  if (process.env.NODE_ENV === "production") return;
  if (process.env.CINATRA_MCP_DEV_ADMIN_BYPASS !== "true") return;
  const raw = process.env.CINATRA_MCP_DEV_TRUSTED_HOSTS;
  if (!raw || raw.trim() === "") return;
  const hosts = Array.from(parseTrustedHosts(raw)).sort();
  if (hosts.length === 0) {
    // A fully-malformed allowlist (e.g.
    // `CINATRA_MCP_DEV_TRUSTED_HOSTS=https://foo.ts.net`) yields no normalized
    // entries. Surface the raw value so the operator sees the typo.
    // eslint-disable-next-line no-console
    console.warn(
      "[mcp-dev-admin-bypass] CINATRA_MCP_DEV_TRUSTED_HOSTS is set but no entries normalized to valid hostnames — extra-loopback trust is INACTIVE. Raw value: " +
        JSON.stringify(raw) +
        ". Bare hostnames only (e.g. `foo.ts.net`); URL-shaped entries with `://` are rejected.",
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(
    "[mcp-dev-admin-bypass] CINATRA_MCP_DEV_TRUSTED_HOSTS active — requests reaching the following hostnames will SKIP OAuth and run as platform_admin: " +
      hosts.join(", ") +
      ". Never list a publicly-reachable hostname unless you accept unauthenticated admin access.",
  );
}

function replaceOriginInString(value: string, sourceOrigin: string, targetOrigin: string) {
  let nextValue = value;

  if (sourceOrigin !== targetOrigin) {
    nextValue = nextValue.replaceAll(sourceOrigin, targetOrigin);
  }

  return nextValue
    .replaceAll("http://localhost:3000", targetOrigin)
    .replaceAll("https://localhost:3000", targetOrigin)
    .replaceAll("http://127.0.0.1:3000", targetOrigin)
    .replaceAll("https://127.0.0.1:3000", targetOrigin);
}

function replaceOriginInValue(value: unknown, sourceOrigin: string, targetOrigin: string): unknown {
  if (typeof value === "string") {
    return replaceOriginInString(value, sourceOrigin, targetOrigin);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => replaceOriginInValue(entry, sourceOrigin, targetOrigin));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceOriginInValue(entry, sourceOrigin, targetOrigin)]),
    );
  }

  return value;
}

async function rewriteJsonOriginResponse(input: {
  request: Request;
  response: Response;
}) {
  const contentType = input.response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return input.response;
  }

  const internalOrigin = new URL(input.request.url).origin;
  const publicOrigin = inferRequestOrigin(input.request);
  if (internalOrigin === publicOrigin) {
    return input.response;
  }

  const body = await input.response.clone().json().catch(() => null);
  if (!body) {
    return input.response;
  }

  const headers = new Headers(input.response.headers);
  headers.delete("content-length");

  return new Response(
    JSON.stringify(replaceOriginInValue(body, internalOrigin, publicOrigin)),
    {
      status: input.response.status,
      statusText: input.response.statusText,
      headers,
    },
  );
}

async function getRequestHeaders() {
  const incomingHeaders = await headers();
  return new Headers(incomingHeaders);
}

function appendCorsHeaders(response: Response) {
  const nextHeaders = new Headers(response.headers);
  nextHeaders.set("Access-Control-Allow-Origin", "*");
  nextHeaders.set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
  nextHeaders.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  nextHeaders.set("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Protocol-Version");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: nextHeaders,
  });
}

function createUnauthorizedResponse(resourceMetadataUrl: string) {
  return appendCorsHeaders(
    Response.json(
      {
        error: "unauthorized",
        message: "Authentication is required to access the Cinatra MCP server.",
      },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
        },
      },
    ),
  );
}

function isOAuthFlowQuery(searchParams: Record<string, string | string[] | undefined>) {
  return [
    "client_id",
    "response_type",
    "redirect_uri",
    "scope",
    "state",
    "prompt",
    "code_challenge",
  ].some((key) => {
    const value = searchParams[key];
    return typeof value === "string" ? value.length > 0 : Array.isArray(value) ? value.length > 0 : false;
  });
}

function stringifySearchParams(searchParams: Record<string, string | string[] | undefined>) {
  const nextSearchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") {
      nextSearchParams.set(key, value);
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        nextSearchParams.append(key, item);
      }
    }
  }

  return nextSearchParams.toString();
}

function readFirstSearchParam(searchParams: Record<string, string | string[] | undefined>, key: string) {
  const value = searchParams[key];
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

function buildSignInHref(handshakeBasePath: string, queryString?: string) {
  // The sign-in route file lives at `<handshakeBasePath>/auth/[path]`, so the
  // sign-in URL must carry the `/auth` segment — a bare `<base>/sign-in` would
  // 404 against the actual route layout.
  const basePath = `${handshakeBasePath}/auth/sign-in`;
  return queryString ? `${basePath}?${queryString}` : basePath;
}

function formatTimestampLabel(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function buildPublicEndpointUrl(baseUrl: string | null, path: string) {
  if (!baseUrl) {
    return null;
  }

  return combineOriginAndPath(baseUrl, path);
}

function createOAuthResourceClient(auth: BetterAuthLike) {
  return createServerAuthClient({
    plugins: [oauthProviderResourceClient(auth as unknown as Auth)],
  });
}

async function verifyMcpAccessToken(input: {
  auth: BetterAuthLike;
  request: Request;
  authBasePath: string;
  mcpBasePath: string;
  requiredScopes: readonly string[];
}) {
  // Multi-origin token verification: a token may have been issued via the local
  // origin (http://localhost:3000) OR via the configured public base URL (in
  // dev: a stable HTTPS endpoint operators choose — Tailscale Funnel, named
  // Cloudflare Tunnel, ngrok; in production: the deployed app's origin). Each
  // issuance binds aud/iss to its issuing origin, so the verifier must accept
  // all configured trusted origins.
  //
  // In production with a single deployed origin, this loop runs once and
  // degenerates to the previous single-origin behavior — no extra cost.
  const authorizationHeader = input.request.headers.get("authorization");
  const accessToken = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length).trim()
    : authorizationHeader?.trim();

  if (!accessToken) {
    return false;
  }

  const authClient = createOAuthResourceClient(input.auth);
  const origins = getTrustedTokenOrigins();
  let lastError: unknown = null;
  for (const origin of origins) {
    try {
      await authClient.verifyAccessToken(accessToken, {
        verifyOptions: {
          audience: combineOriginAndPath(origin, input.mcpBasePath),
          issuer: combineOriginAndPath(origin, input.authBasePath),
        },
        jwksUrl: `${combineOriginAndPath(origin, input.authBasePath)}/jwks`,
        scopes: [...input.requiredScopes],
      });
      return true;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("verifyMcpAccessToken: no trusted origins configured");
}

// ---------------------------------------------------------------------------
// Per-request context storage — carries clientId from OAuth JWT to tool handlers
// without threading it through every function signature.
// ---------------------------------------------------------------------------

/**
 * Decode the `sub` claim from a Bearer JWT without verifying the signature.
 * For client_credentials tokens issued by Better Auth's oauth-provider, `sub`
 * is the OAuth client_id. Used only for actor-context injection — the token
 * has already been verified by verifyAuthorizationHeader above.
 */
function decodeJwtClientId(authorizationHeader: string | null): string | undefined {
  try {
    const token = authorizationHeader?.startsWith("Bearer ")
      ? authorizationHeader.slice("Bearer ".length).trim()
      : authorizationHeader?.trim();
    if (!token) return undefined;
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    // Better Auth client_credentials tokens set azp = clientId (no sub claim).
    // Fall back to sub for user-session JWTs, then explicit clientId field.
    const clientId =
      typeof payload.clientId === "string" ? payload.clientId
      : typeof payload.azp === "string" ? payload.azp
      : typeof payload.sub === "string" ? payload.sub
      : undefined;
    return clientId;
  } catch {
    return undefined;
  }
}

async function fetchOAuthClients(auth: BetterAuthLike) {
  const authApi = auth.api as Record<string, unknown>;
  const getOAuthClients = authApi.getOAuthClients as
    | ((input: { headers: Headers }) => Promise<unknown>)
    | undefined;

  return ((await getOAuthClients?.({
    headers: await getRequestHeaders(),
  })) ?? []) as OAuthClientRecord[];
}

async function fetchOAuthClient(auth: BetterAuthLike, clientId: string) {
  const authApi = auth.api as Record<string, unknown>;
  const getOAuthClient = authApi.getOAuthClient as
    | ((input: { headers: Headers; query: { client_id: string } }) => Promise<unknown>)
    | undefined;

  return (await getOAuthClient?.({
    headers: await getRequestHeaders(),
    query: {
      client_id: clientId,
    },
  })) as OAuthClientRecord | null;
}

function matchesSelfClientCandidate(client: OAuthClientRecord, configuredClientId?: string | null) {
  return (
    client.client_id === SELF_MCP_CLIENT_ID ||
    (configuredClientId ? client.client_id === configuredClientId : false) ||
    (client.client_name?.trim() ?? "") === SELF_MCP_CLIENT_NAME
  );
}

function buildSelfClientSettings(input: {
  client: OAuthClientMutationResponse;
  clientSecret: string | null;
  managedBy: "cli" | "manual";
}): McpServerSettings["selfClient"] {
  const client = input.client;
  return {
    clientId: client.client_id,
    clientSecret: input.clientSecret,
    clientName: client.client_name?.trim() || SELF_MCP_CLIENT_NAME,
    scope: client.scope?.trim() || SELF_MCP_CLIENT_SCOPE,
    tokenEndpointAuthMethod:
      client.token_endpoint_auth_method === "none" || client.token_endpoint_auth_method === "client_secret_post"
        ? client.token_endpoint_auth_method
        : "client_secret_basic",
    grantTypes: Array.isArray(client.grant_types) ? [...client.grant_types] : ["client_credentials"],
    createdAt:
      typeof client.client_id_issued_at === "number" && Number.isFinite(client.client_id_issued_at)
        ? new Date(client.client_id_issued_at * 1000).toISOString()
        : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    managedBy: input.managedBy,
  };
}

async function postOAuthClientMutation<T>(input: {
  request: Request;
  authBasePath: string;
  pathname: string;
  body: unknown;
  fallbackError: string;
}) {
  const requestHeaders = new Headers(await getRequestHeaders());
  requestHeaders.set("content-type", "application/json");

  const response = await fetch(new URL(`${input.authBasePath}${input.pathname}`, input.request.url), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(input.body),
    cache: "no-store",
  });

  const rawText = await response.text().catch(() => "");
  const payload = rawText
    ? ((JSON.parse(rawText) as { message?: string; error_description?: string } | T | null) ?? null)
    : null;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
        ? payload.message
        : payload && typeof payload === "object" && "error_description" in payload && typeof payload.error_description === "string"
          ? payload.error_description
          : `${input.fallbackError} (HTTP ${response.status}: ${rawText.slice(0, 200)})`;
    throw new Error(message);
  }

  return payload as T;
}

async function fetchOAuthClientPublic(auth: BetterAuthLike, clientId: string) {
  const authApi = auth.api as Record<string, unknown>;
  const getOAuthClientPublic = authApi.getOAuthClientPublic as
    | ((input: { headers: Headers; query: { client_id: string } }) => Promise<unknown>)
    | undefined;

  return (await getOAuthClientPublic?.({
    headers: await getRequestHeaders(),
    query: {
      client_id: clientId,
    },
  })) as OAuthClientRecord | null;
}

async function requireMountedSession(
  getSession: () => Promise<SessionLike | null>,
  handshakeBasePath: string,
  queryString?: string,
) {
  const session = await getSession();

  if (!session) {
    redirect(buildSignInHref(handshakeBasePath, queryString));
  }

  return session;
}

function isAdminSession(session: SessionLike) {
  const roles = String(session.user.role ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return roles.includes("admin");
}

async function requireMountedAdminSession(
  getSession: () => Promise<SessionLike | null>,
  handshakeBasePath: string,
  queryString?: string,
) {
  const session = await requireMountedSession(getSession, handshakeBasePath, queryString);
  if (!isAdminSession(session)) {
    redirect("/not-authorized");
  }

  return session;
}

function OverviewLink(props: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={props.href}
      className="rounded-panel border border-line bg-surface-strong px-5 py-5 shadow-[0_20px_50px_rgba(15,23,42,0.05)] transition hover:-translate-y-0.5 hover:border-border hover:shadow-[0_24px_56px_rgba(15,23,42,0.1)]"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-lg font-semibold text-foreground">{props.title}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{props.description}</p>
        </div>
        <span className="mt-1 text-muted-foreground" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
            <path d="M7 17 17 7" />
            <path d="M9 7h8v8" />
          </svg>
        </span>
      </div>
    </Link>
  );
}

// Re-export the pure module surface so the existing barrel-import call site
// in src/lib/auth.ts (which uses `createMcpServerAuthPlugins`) keeps working,
// and so the shared Cinatra plugin builder at src/lib/better-auth-plugins.ts
// can pull the pure pieces through the same `@cinatra-ai/mcp-server` package
// it already depends on. The pure module enforces app-graph-free imports.
export {
  buildMcpAuthPlugins,
  DEFAULT_MCP_SCOPES,
  CLI_SCOPES,
  type McpAuthPlugins,
  type McpAuthPluginsOptions,
};

// Facade re-exports for the split runtime/request-context modules (eng#305).
// Public consumers keep importing these from `@cinatra-ai/mcp-server`; the
// facade re-exports DOWNWARD only (no subpath, no `Symbol.for` backing). The
// runtime types (`McpRuntimeToolServer`/`ScreenDescriptor`) are consumed by
// every per-package MCP registry, and `mcpRequestContextStorage` /
// `McpRequestContext` / `DelegatedMcpActor` by the app + agent layers.
export {
  createMcpRuntimeServer,
  type McpRuntimeToolServer,
  type NavigationTarget,
  type ScreenDescriptor,
} from "./runtime-server";
export {
  mcpRequestContextStorage,
  type DelegatedMcpActor,
  type McpRequestContext,
} from "./request-context";

// The delegated-chat tool allowlist predicate — re-exported so in-process
// primitive invokers (e.g. the host self-MCP `ctx.mcp.callPrimitive`) can apply
// the SAME delegated-chat gate the live transport's `policedRegisterTool` does.
export { isDelegatedChatMcpToolAllowed } from "./delegated-chat-tool-policy";

export function createMcpServerAuthPlugins(
  options: CreateMcpServerAuthPluginsOptions = {},
): McpAuthPlugins {
  const mcpBasePath = normalizePath(options.mcpBasePath, "/api/mcp");
  // OAuth handshake pages (auth/account/consent) advertised to external MCP
  // clients live under handshakeBasePath; default to the JSON-RPC base.
  const handshakeBasePath = normalizePath(options.handshakeBasePath, "/api/mcp");
  const scopes = [...(options.scopes ?? DEFAULT_SCOPES)];
  const localMcpUrl = getLocalMcpServerUrl(mcpBasePath);
  // Include the configured public MCP URL (stable HTTPS endpoint set via
  // /configuration/development?tab=tunnel, or the deployed app origin in
  // production) so OpenAI's MCP client — which sends `resource=<public URL>`
  // per RFC 8707 — receives a JWT bound to that audience. Without this entry,
  // the resource doesn't match validAudiences, oauth-provider falls back to an
  // opaque token, and verifyMcpAccessToken (JWT-only) rejects it with 401.
  const publicMcpUrl = getPublicMcpServerUrl();
  const validAudiences = publicMcpUrl ? [localMcpUrl, publicMcpUrl] : [localMcpUrl];

  // eng#231: extend validAudiences with `<origin><extraBasePath>` for each
  // configured extra base path (e.g. /api/cli), on BOTH the local and public
  // origins, so an authorize with `resource=<origin>/api/cli` mints a JWT
  // bound to that dedicated audience. The MCP audiences are unchanged — each
  // verifier still pins its OWN audience (reciprocal isolation).
  const extraBasePaths = (options.extraAudienceBasePaths ?? []).map((p) =>
    normalizePath(p, p),
  );
  if (extraBasePaths.length > 0) {
    const origins: string[] = [];
    try {
      origins.push(new URL(localMcpUrl).origin);
    } catch {
      /* malformed local URL — skip */
    }
    if (publicMcpUrl) {
      try {
        origins.push(new URL(publicMcpUrl).origin);
      } catch {
        /* malformed public URL — skip */
      }
    }
    for (const origin of origins) {
      for (const basePath of extraBasePaths) {
        const audience = `${origin}${basePath}`;
        if (!validAudiences.includes(audience)) validAudiences.push(audience);
      }
    }
  }

  const urls = buildMcpHandshakeUrls(handshakeBasePath);
  return buildMcpAuthPlugins({
    validAudiences,
    scopes,
    loginPage: urls.loginPage,
    consentPage: urls.consentPage,
    signupPage: urls.signupPage,
    ...(options.clientRegistrationDefaultScopes
      ? { clientRegistrationDefaultScopes: options.clientRegistrationDefaultScopes }
      : {}),
    ...(options.clientRegistrationAllowedScopes
      ? { clientRegistrationAllowedScopes: options.clientRegistrationAllowedScopes }
      : {}),
  });
}

export function createMcpServerMount(options: CreateMcpServerMountOptions) {
  const adminBasePath = normalizePath(options.adminBasePath, "/configuration/mcp");
  const handshakeBasePath = normalizePath(options.handshakeBasePath, "/api/mcp");
  const authBasePath = normalizePath(options.authBasePath, "/api/auth");
  const mcpBasePath = normalizePath(options.mcpBasePath, "/api/mcp");
  const serverName = options.serverName ?? "Cinatra MCP Server";
  const serverVersion = options.serverVersion ?? "0.1.0";
  const reagentName = options.reagentName ?? serverName;
  const scopes = [...(options.scopes ?? DEFAULT_SCOPES)];
  const protectedResourceScopes = scopes.filter((scope) => !["openid", "profile", "email", "offline_access"].includes(scope));
  const defaultScope = scopes.join(" ");

  const authorizationServerMetadataHandler = oauthProviderAuthServerMetadata(
    options.auth as unknown as Parameters<typeof oauthProviderAuthServerMetadata>[0],
  );
  const openIdConfigurationHandler = oauthProviderOpenIdConfigMetadata(
    options.auth as unknown as Parameters<typeof oauthProviderOpenIdConfigMetadata>[0],
  );


  async function transportHandler(request: Request) {
    if (request.method === "OPTIONS") {
      return appendCorsHeaders(new Response(null, { status: 204 }));
    }

    if (!["POST", "GET", "DELETE"].includes(request.method)) {
      return appendCorsHeaders(new Response("Method not allowed", { status: 405 }));
    }

    const origin = inferRequestOrigin(request);
    const resourceMetadataUrl = combineOriginAndPath(origin, metadataPathFor(mcpBasePath));

    // Try the delegated on-behalf-of actor token first. When present and valid
    // it IS the authentication: the chat user's identity travels in a short-lived
    // signed token relayed by OpenAI's hosted MCP infra. A non-delegated bearer
    // falls through to verifyMcpAccessToken.
    const earlyAuthHeader = request.headers.get("authorization");
    // Bind the delegated token to THIS request's canonical MCP audience + auth
    // issuer (exact match, not membership) so a token
    // minted for the public funnel URL cannot be replayed against localhost
    // (or a different instance) even if the signing secret is shared.
    const expectedDelegatedAudience = combineOriginAndPath(origin, mcpBasePath);
    const expectedDelegatedIssuer = combineOriginAndPath(origin, authBasePath);
    let delegatedActor: DelegatedMcpActor | null = null;
    try {
      delegatedActor =
        (await options.verifyDelegatedActorToken?.({
          authHeader: earlyAuthHeader,
          request,
          expectedAudience: expectedDelegatedAudience,
          expectedIssuer: expectedDelegatedIssuer,
        })) ?? null;
    } catch {
      delegatedActor = null;
    }

    // Surface trusted-hosts allowlist visibility on first request.
    emitDevTrustedHostsWarningOnce();

    // Requests arriving directly at localhost (or an env-allowlisted trusted
    // dev host; see CINATRA_MCP_DEV_TRUSTED_HOSTS) bypass OAuth —
    // auth is handled at the network level (only callers who reach a trusted
    // host can hit it). Requests tunnelled through any other public proxy
    // must carry a valid Bearer token — UNLESS a valid delegated actor token
    // is present, which is itself the auth.
    if (!isTrustedDevHostRequest(request) && !delegatedActor) {
      try {
        const verified = await verifyMcpAccessToken({
          auth: options.auth,
          request,
          authBasePath,
          mcpBasePath,
          requiredScopes: scopes.includes("mcp:connect") ? ["mcp:connect"] : [],
        });

        if (!verified) {
          return createUnauthorizedResponse(resourceMetadataUrl);
        }
      } catch {
        return createUnauthorizedResponse(resourceMetadataUrl);
      }
    }

    const server = await createMcpRuntimeServer({
      name: serverName,
      version: serverVersion,
      registerCapabilities: options.registerCapabilities,
      instructions: options.serverInstructions,
      experimental: options.serverExperimental,
      // Only the CHAT delegation type triggers the chat tool-policy
      // allowlist. agent-run delegation is unrestricted at registration
      // time — per-handler authz + `enforceMcpBoundary` still gate
      // mutations. The chat allowlist is intentionally narrow (read +
      // dispatch only); applying it to agent runs would block the
      // operations the agent was dispatched to perform.
      toolPolicyMode:
        delegatedActor?.delegation === "chat" ? "delegated-chat" : "unrestricted",
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);

    const parsedBody =
      request.method === "POST" ? await request.clone().json().catch(() => undefined) : undefined;
    await writeMcpServerLogFile({
      label: "transport",
      kind: "request",
      body: {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        parsedBody: parsedBody ?? null,
      },
    });

    // The MCP Streamable HTTP spec requires Accept: application/json, text/event-stream.
    // Some clients (e.g. OpenAI) only send Accept: application/json.
    // In stateless + enableJsonResponse mode, SSE is never used, so we normalise
    // the Accept header to satisfy the SDK validator without changing behaviour.
    const acceptHeader = request.headers.get("accept") ?? "";
    // Normalise Accept to include text/event-stream so the MCP SDK validator is
    // satisfied even when clients only send application/json (e.g. OpenAI).
    // Avoid `new Request(request, init)` — that form tries to copy the private
    // #state field from `request`, which fails when Next.js's bundled undici
    // and the vendored MCP undici are different class instances.
    const normalisedRequest = acceptHeader.includes("text/event-stream")
      ? request
      : new Request(request.url, {
          method: request.method,
          headers: new Headers({
            ...Object.fromEntries(request.headers.entries()),
            accept: acceptHeader ? `${acceptHeader}, text/event-stream` : "application/json, text/event-stream",
          }),
          // Body must be omitted for bodyless methods to avoid "duplex" errors.
          ...(request.method !== "GET" && request.method !== "HEAD" && request.method !== "DELETE"
            ? { body: request.body, duplex: "half" }
            : {}),
        });

    // Inject clientId from the JWT into AsyncLocalStorage so tool handlers can
    // resolve the calling assistant's identity without SDK changes.
    // Fall back to the raw token when decodeJwtClientId returns undefined
    // (e.g. A2A_DEV_BYPASS sentinel "dev-bypass" is not a 3-part JWT) so the
    // in-process registry writer and reader agree on the same key.
    const authHeader = earlyAuthHeader;
    const rawToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : authHeader?.trim();
    // A delegated-token request carries the human chat user's identity, not an
    // OAuth client. Suppress clientId resolution so the
    // run-context registry / service-account lookups don't treat the OBO
    // token as a machine client id.
    const requestClientId = delegatedActor
      ? undefined
      : decodeJwtClientId(authHeader) ?? rawToken ?? undefined;
    // Also carry orgId + userId from the better-auth session so tool handlers
    // (e.g. objects_save) can enforce org-scoped writes. The
    // session has already been authenticated by the enclosing MCP route handler;
    // fetching it again here is cheap (better-auth caches the current request).
    const sessionForActor = await options.getSession().catch(() => null);
    const sessionUser = sessionForActor?.user as { id?: string | null; activeOrganizationId?: string | null; role?: string | null } | undefined;
    // Resolve platformRole from the better-auth session role (a comma-separated
    // string per better-auth's admin plugin) so agent-side
    // registries (e.g. agents/src/mcp/registry.ts:buildActorFromMcpContext)
    // can stamp platformRole:"platform_admin" on the actor envelope without
    // re-reading cookies inside primitive handlers. Without this hint, MCP
    // calls originating from a chat assistant or other cookie-authenticated
    // surface arrive at admin-gated handlers (e.g. agent_source_publish) with
    // platformRole:undefined and fail despite the user actually being admin.
    const sessionPlatformRole: "platform_admin" | "member" | undefined = sessionUser
      ? (String(sessionUser.role ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .includes("admin")
          ? "platform_admin"
          : "member")
      : undefined;
    // Dev-only MCP admin bypass for loopback or an env-allowlisted trusted dev
    // host. See `./dev-admin-bypass.ts` for the policy + rationale.
    const devAdminBypassActive = shouldGrantDevAdminBypass({
      nodeEnv: process.env.NODE_ENV,
      envBypassFlag: process.env.CINATRA_MCP_DEV_ADMIN_BYPASS,
      isTrustedDevHost: isTrustedDevHostRequest(request),
    });
    // A delegated actor token's platformRole/org win over the (absent)
    // hosted-MCP session. devAdminBypass still wins over everything when
    // explicitly enabled for loopback/trusted-dev-host.
    const resolvedPlatformRole: "platform_admin" | "member" | undefined =
      devAdminBypassActive
        ? "platform_admin"
        : delegatedActor?.platformRole ?? sessionPlatformRole;
    let resolvedOrgId: string | null =
      delegatedActor?.orgId ?? sessionUser?.activeOrganizationId ?? null;
    // Trusted-dev-host fallback for cube identity. Runs FIRST so its
    // coherent `{adminUserId, adminOrgId}`
    // pair wins over the older A2A_DEV_BYPASS oldest-org fallback when both
    // env flags are on (combining them risked a
    // `{first-admin-user, oldest-org}` mismatch that fails cross-tenant
    // membership checks). INNER JOIN on `member` so we never return
    // `{adminUserId, orgId: null}` — admin must have a real membership.
    //
    // Fires only when: dev mode (`CINATRA_MCP_DEV_ADMIN_BYPASS=true`), the
    // request hit a trusted host, no delegated chat token, no cookie
    // session. Production never enters because OAuth check above blocks
    // unauthenticated remote calls and the env flag is dev-mode-only.
    let trustedDevAdminUserId: string | null = null;
    if (
      process.env.CINATRA_MCP_DEV_ADMIN_BYPASS === "true" &&
      isTrustedDevHostRequest(request) &&
      !delegatedActor &&
      !sessionUser?.id &&
      !requestClientId
    ) {
      try {
        const adminRow = await betterAuthPool.query<{
          userId: string;
          orgId: string;
        }>(
          `SELECT u.id AS "userId", m."organizationId" AS "orgId"
           FROM public."user" u
           INNER JOIN public."member" m ON m."userId" = u.id
           WHERE u.role = 'admin'
           ORDER BY u."createdAt" ASC, m."createdAt" ASC
           LIMIT 1`,
        );
        const row = adminRow.rows[0];
        if (row?.userId && row?.orgId) {
          trustedDevAdminUserId = row.userId;
          resolvedOrgId = row.orgId;
        }
      } catch {
        // non-fatal — tools will fall back to cinatra-default group
      }
    }
    // When A2A_DEV_BYPASS is active and the request has no user session (e.g.
    // Python Docker agent calling host.docker.internal), fall back to the first
    // org in the DB so that objects_save/update write to the correct Graphiti group
    // and objects appear at /objects for the logged-in user.
    if (!resolvedOrgId && process.env.A2A_DEV_BYPASS === "true" && isLocalhostRequest(request)) {
      try {
        const result = await betterAuthPool.query<{ id: string }>(
          'SELECT id FROM public.organization ORDER BY "createdAt" ASC LIMIT 1',
        );
        resolvedOrgId = result.rows[0]?.id ?? null;
      } catch {
        // non-fatal — tools will fall back to cinatra-default group
      }
    }
    // Extend dev-bypass to llm-bridge LLM tasks: OpenAI's native MCP relay
    // originates from OpenAI's servers, not localhost, so the check
    // above never fires for llm-bridge-initiated MCP calls. When A2A_DEV_BYPASS
    // is active and the request carries a valid run-context entry (set by an
    // authenticated llm-bridge call before the LLM step), treat it as a
    // trusted internal actor and apply the same org fallback.
    if (!resolvedOrgId && process.env.A2A_DEV_BYPASS === "true") {
      const earlyCtx = requestClientId ? options.getRunContext?.(requestClientId) : undefined;
      if (earlyCtx?.runId) {
        try {
          const result = await betterAuthPool.query<{ id: string }>(
            'SELECT id FROM public.organization ORDER BY "createdAt" ASC LIMIT 1',
          );
          resolvedOrgId = result.rows[0]?.id ?? null;
        } catch {
          // non-fatal
        }
      }
    }
    // Compose userId from cookie / service-account / localhost-admin so
    // cookieless MCP transports (Claude Code on localhost, tunneled service
    // accounts) carry an actor userId. The agent-builder MCP registry actor
    // injection only fires when this is non-null. The delegated actor token's
    // `userId` is the human chat user; it wins over the
    // cookie/service-account/localhost-admin chain.
    // `trustedDevAdminUserId` is set BEFORE `resolveActorIdentity()` so the
    // coherent admin/member pair from the trusted-dev branch wins over
    // `resolveActorIdentity()`'s own A2A_DEV_BYPASS admin lookup, which can
    // return a different admin (no org) when both env flags are on.
    // When neither delegated nor trusted-dev applies, fall
    // back to the cookie/service-account/localhost-admin chain.
    const resolvedUserId =
      delegatedActor?.userId ??
      trustedDevAdminUserId ??
      (await resolveActorIdentity({
        sessionUser,
        requestClientId,
        request,
        env: { A2A_DEV_BYPASS: process.env.A2A_DEV_BYPASS },
        isLocalhost: isLocalhostRequest(request),
        readServiceAccount: readServiceAccountByClientId,
        pool: betterAuthPool,
      }));
    // Resolve the caller's role in the active org ONCE, AFTER the full
    // orgId/userId resolution chain (cookie session, delegated OBO token,
    // trusted-dev / A2A dev bypass) has settled, so the carried `orgRole` is
    // always coherent with the `orgId`/`userId` stamped on this same store
    // frame. Undefined when either id is missing or no membership row exists
    // — downstream gates keep their on-demand fallback (never widens).
    const resolvedOrgRole = await resolveOrgRoleFromMembership({
      orgId: resolvedOrgId,
      userId: resolvedUserId,
      pool: betterAuthPool,
    });
    // Resolve agent run-context.
    //
    // Primary path: options.getRunContext callback (written by the bridge route
    // into src/lib/agent-run-context-registry.ts before each LLM
    // step). The callback lives in the Next.js app bundle — a true singleton
    // regardless of how Turbopack chunks the packages/mcp-server module.
    //
    // Fallback path: X-Cinatra-* headers (for non-OpenAI callers that preserve
    // custom headers, e.g. direct Python→MCP calls when a real auth header exists).
    // OpenAI strips all custom headers when relaying MCP tool calls, so the
    // in-process registry is the only reliable mechanism for agent runs.
    const registryCtx =
      (requestClientId ? options.getRunContext?.(requestClientId) : undefined);
    const requestRunId =
      registryCtx?.runId ?? request.headers.get("x-cinatra-run-id") ?? undefined;
    const requestAgentId =
      registryCtx?.agentId ?? request.headers.get("x-cinatra-agent-id") ?? undefined;
    const requestPackageVersion =
      registryCtx?.packageVersion ?? request.headers.get("x-cinatra-package-version") ?? undefined;
    const requestAgentSpecVersion =
      registryCtx?.agentSpecVersion ??
      request.headers.get("x-cinatra-agent-spec-version") ?? undefined;
    const requestStore: {
      clientId?: string;
      orgId?: string | null;
      userId?: string | null;
      runId?: string;
      agentId?: string;
      packageVersion?: string;
      agentSpecVersion?: string;
      platformRole?: "platform_admin" | "member";
      orgRole?: "org_owner" | "org_admin" | "member";
      delegatedActor?: DelegatedMcpActor | null;
      delegatedRestricted?: boolean;
    } = {
      clientId: requestClientId,
      orgId: resolvedOrgId,
      userId: resolvedUserId,
      // For agent-run delegated tokens, prefer the runId encoded in the
      // delegated actor — it's authoritative (signed at mint time), not
      // a forgeable header. The registry-resolved + header runId is kept
      // as a fallback for non-delegated callers (legacy A2A bridge token
      // paths that haven't been migrated yet).
      runId:
        delegatedActor?.delegation === "agent_run"
          ? delegatedActor.runId
          : requestRunId,
      agentId: requestAgentId,
      packageVersion: requestPackageVersion,
      agentSpecVersion: requestAgentSpecVersion,
      platformRole: resolvedPlatformRole,
      orgRole: resolvedOrgRole,
      // delegated-chat allowlist is keyed on the CHAT delegation type only.
      // agent-run delegated tokens are unrestricted at registration time
      // (the dispatched agent's job IS to mutate); per-handler authz +
      // `enforceMcpBoundary` still gate the rest.
      delegatedActor,
      delegatedRestricted: delegatedActor?.delegation === "chat",
    };
    const response = await mcpRequestContextStorage.run(
      requestStore,
      () => transport.handleRequest(normalisedRequest, { parsedBody }),
    ) as Response;

    const responseContentType = response.headers.get("content-type");
    const responseBody = responseContentType?.includes("application/json")
      ? await response.clone().json().catch(() => null)
      : await response.clone().text().catch(() => null);

    await writeMcpServerLogFile({
      label: "transport",
      kind: "response",
      body: {
        method: request.method,
        url: request.url,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      },
    });

    return appendCorsHeaders(response);
  }

  async function protectedResourceMetadataHandler(request: Request) {
    const origin = inferRequestOrigin(request);
    const resourceClient = createOAuthResourceClient(options.auth);

    const metadata = await resourceClient.getProtectedResourceMetadata({
      resource: combineOriginAndPath(origin, mcpBasePath),
      authorization_servers: [combineOriginAndPath(origin, authBasePath)],
      scopes_supported: protectedResourceScopes,
      resource_name: reagentName,
      resource_documentation: combineOriginAndPath(origin, adminBasePath),
    });

    return appendCorsHeaders(
      Response.json(metadata, {
        status: 200,
      }),
    );
  }

  async function mcpLayout(props: { children: ReactNode }) {
    return <McpAuthUiProvider>{props.children}</McpAuthUiProvider>;
  }

  async function readMountedSettings() {
    return normalizeMcpServerSettings(await options.readSettings?.());
  }

  async function writeMountedSettings(value: Partial<McpServerSettings>) {
    const nextSettings = normalizeMcpServerSettings({
      ...(await readMountedSettings()),
      ...value,
      updatedAt: new Date().toISOString(),
    });
    await options.writeSettings?.(nextSettings);
    try {
      revalidatePath(adminBasePath);
    } catch {
      // revalidatePath is a no-op outside a Next.js request context.
    }
    return nextSettings;
  }

  async function deleteOAuthClientById(_request: Request, clientId: string) {
    const authApi = options.auth.api as Record<string, unknown>;
    const deleteOAuthClient = authApi.deleteOAuthClient as
      | ((input: { headers: Headers; body: { client_id: string } }) => Promise<unknown>)
      | undefined;
    await deleteOAuthClient?.({
      headers: await getRequestHeaders(),
      body: { client_id: clientId },
    });
  }

  async function overviewPage({ searchParams }: { searchParams?: Record<string, string> } = {}) {
    const session = await requireMountedAdminSession(options.getSession, handshakeBasePath);
    const settings = await readMountedSettings();
    const localBaseUrl = inferLocalAppOrigin();
    const isDevMode = process.env.CINATRA_RUNTIME_MODE === "development";
    const checkResult = searchParams?.check ?? null;
    const checkedProvider = searchParams?.provider ?? null;
    const configuredProviders = options.readConfiguredLlmProviders ? await options.readConfiguredLlmProviders() : [];
    const rawReqUrl = searchParams?.reqUrl ?? null;
    const rawResStatus = searchParams?.resStatus ?? null;
    const rawResAuth = searchParams?.resAuth ?? null;
    const rawResBody = searchParams?.resBody ?? null;

    const publicTransportUrl = buildPublicEndpointUrl(settings.publicBaseUrl, mcpBasePath);
    const publicProtectedResourceUrl = buildPublicEndpointUrl(settings.publicBaseUrl, metadataPathFor(mcpBasePath));
    const publicAuthorizationMetadataUrl = buildPublicEndpointUrl(
      settings.publicBaseUrl,
      issuerMetadataPathFor(authBasePath, "/.well-known/oauth-authorization-server"),
    );
    const publicOpenIdMetadataUrl = buildPublicEndpointUrl(
      settings.publicBaseUrl,
      issuerMetadataPathFor(authBasePath, "/.well-known/openid-configuration"),
    );
    const localTransportUrl = buildPublicEndpointUrl(localBaseUrl, mcpBasePath);
    const localProtectedResourceUrl = buildPublicEndpointUrl(localBaseUrl, metadataPathFor(mcpBasePath));
    const localAuthorizationMetadataUrl = buildPublicEndpointUrl(
      localBaseUrl,
      issuerMetadataPathFor(authBasePath, "/.well-known/oauth-authorization-server"),
    );
    const localOpenIdMetadataUrl = buildPublicEndpointUrl(
      localBaseUrl,
      issuerMetadataPathFor(authBasePath, "/.well-known/openid-configuration"),
    );
    const updatedAtLabel = formatTimestampLabel(settings.updatedAt);

    let rawReqDisplay: string | null = null;
    if (rawReqUrl) {
      try {
        const u = new URL(rawReqUrl);
        rawReqDisplay = `GET ${u.pathname}${u.search} HTTP/1.1\nHost: ${u.host}`;
      } catch {
        rawReqDisplay = `GET ${rawReqUrl} HTTP/1.1`;
      }
    }
    const rawResDisplay = rawResStatus
      ? [
          `HTTP/1.1 ${rawResStatus}`,
          rawResAuth ? `WWW-Authenticate: ${rawResAuth}` : null,
          "",
          rawResBody || "(empty body)",
        ]
          .filter((l): l is string => l !== null)
          .join("\n")
      : null;

    return (
      <main className="min-h-screen px-5 py-8 sm:px-8 lg:px-6 lg:py-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          <PageHeader
            title="MCP server"
            description="Configure the application-wide Cinatra MCP server, discovery metadata, and OAuth clients that can reach it."
          />

          <section className="flex flex-col gap-6">
            <div className="grid gap-3 text-sm text-muted-foreground">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-base font-semibold text-foreground">Public endpoints</h2>
                <div className="flex items-center gap-2">
                  {configuredProviders.length > 0 && (
                    <form action={`${adminBasePath}/connectivity-check`} method="POST" className="flex items-center gap-2">
                      {configuredProviders.length > 1 && (
                        <select
                          name="provider"
                          defaultValue={checkedProvider ?? configuredProviders[0] ?? ""}
                          disabled={!settings.publicBaseUrl}
                          className="rounded-full border border-line bg-surface-strong px-3 py-2 text-sm text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {configuredProviders.map((p) => (
                            <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                          ))}
                        </select>
                      )}
                      {configuredProviders.length === 1 && (
                        <input type="hidden" name="provider" value={configuredProviders[0]} />
                      )}
                      <Button
                        type="submit"
                        variant="outline"
                        disabled={!settings.publicBaseUrl}
                      >
                        Check reachability
                        {configuredProviders.length === 1 && (
                          <span className="ml-1 text-muted-foreground">({configuredProviders[0].charAt(0).toUpperCase() + configuredProviders[0].slice(1)})</span>
                        )}
                      </Button>
                    </form>
                  )}
                </div>
              </div>

              {settings.publicBaseUrl ? (
                <>
                  {publicTransportUrl ? (
                    <code className="rounded-xl border border-line bg-surface-muted px-3 py-2">{publicTransportUrl}</code>
                  ) : null}
                  {publicProtectedResourceUrl ? (
                    <code className="rounded-xl border border-line bg-surface-muted px-3 py-2">{publicProtectedResourceUrl}</code>
                  ) : null}
                  {publicAuthorizationMetadataUrl ? (
                    <code className="rounded-xl border border-line bg-surface-muted px-3 py-2">{publicAuthorizationMetadataUrl}</code>
                  ) : null}
                  {publicOpenIdMetadataUrl ? (
                    <code className="rounded-xl border border-line bg-surface-muted px-3 py-2">{publicOpenIdMetadataUrl}</code>
                  ) : null}
                </>
              ) : (
                <p className="text-muted-foreground">No public base URL is configured yet.</p>
              )}
            </div>

            {checkResult ? (
              <McpCheckResultModal
                checkResult={checkResult}
                checkedProvider={checkedProvider}
                rawReqDisplay={rawReqDisplay}
                rawResDisplay={rawResDisplay}
                adminBasePath={adminBasePath}
                statusCode={searchParams?.status}
              />
            ) : null}

            <div>
              <form action={`${adminBasePath}/public-url`} method="POST" className="grid gap-3 rounded-panel border border-line bg-surface p-4">
                <Field>
                  <FieldLabel>Public base URL</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <LinkIcon aria-hidden="true" />
                    </InputGroupAddon>
                    <InputGroupInput
                      type="url"
                      name="publicBaseUrl"
                      defaultValue={settings.publicBaseUrl ?? ""}
                      placeholder="https://mcp.example.com"
                    />
                  </InputGroup>
                </Field>
                <p className="text-xs leading-5 text-muted-foreground">
                  Externally reachable base URL for this MCP server. In development, point this at a stable
                  HTTPS endpoint that forwards to <code>http://localhost:3000</code> — for example a Tailscale
                  Funnel, a named Cloudflare Tunnel, or a reserved ngrok domain. Leave empty to clear.
                </p>
                <div>
                  <Button type="submit">
                    Save URL
                  </Button>
                </div>
              </form>
            </div>

            <div className="grid gap-3 text-sm text-muted-foreground">
              <h2 className="text-base font-semibold text-foreground">Local endpoints</h2>
              <code className="rounded-xl border border-line bg-surface-muted px-3 py-2">{localBaseUrl}</code>
              <code className="rounded-xl border border-line bg-surface-muted px-3 py-2">{localTransportUrl}</code>
              <code className="rounded-xl border border-line bg-surface-muted px-3 py-2">{localProtectedResourceUrl}</code>
              <code className="rounded-xl border border-line bg-surface-muted px-3 py-2">{localAuthorizationMetadataUrl}</code>
              <code className="rounded-xl border border-line bg-surface-muted px-3 py-2">{localOpenIdMetadataUrl}</code>
            </div>

          </section>

        </div>
      </main>
    );
  }

  async function authPage(props: {
    params: Promise<{ path: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) {
    const [{ path }, searchParams, session] = await Promise.all([
      props.params,
      props.searchParams,
      options.getSession(),
    ]);
    const queryString = stringifySearchParams(searchParams);
    const oauthFlow = isOAuthFlowQuery(searchParams);

    if (session && path !== "sign-out" && !oauthFlow) {
      redirect(adminBasePath);
    }

    return (
      <main className="flex min-h-screen items-center justify-center px-5 py-8 sm:px-8 lg:px-6 lg:py-6">
        <div className="w-full max-w-md">
          <Card className="border-line bg-surface backdrop-blur-none">
            <CardContent className="grid gap-5 p-6 sm:p-8">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">MCP Access</p>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
                {path === "sign-up" ? "Create your account" : path === "sign-out" ? "Sign out" : "Sign in"}
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Use your Cinatra account to manage MCP access and authorize OAuth clients.
              </p>
            </div>

            <McpAuthFlowBridge
              authBasePath={authBasePath}
              fallbackHref={adminBasePath}
              path={path}
              queryString={queryString}
            />

            <AuthView path={path} />
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  async function accountPage(props: { params: Promise<{ path: string }> }) {
    const [{ path }] = await Promise.all([props.params, requireMountedSession(options.getSession, handshakeBasePath)]);

    return (
      <main className="min-h-screen px-5 py-8 sm:px-8 lg:px-6 lg:py-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          <Card className="border-line bg-surface backdrop-blur-none">
            <CardContent className="p-6">
            <div className="mb-6">
              <p className="section-kicker">MCP Account</p>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-foreground">Account settings</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Manage the sign-in details and active sessions used for MCP access.
              </p>
            </div>
            <AccountView path={path} />
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  async function clientsPage() {
    await requireMountedAdminSession(options.getSession, handshakeBasePath);
    const clients = await fetchOAuthClients(options.auth);
    const connectedProviders = options.readConfiguredLlmProviders
      ? await options.readConfiguredLlmProviders()
      : [];
    const llmAccessStatus = await getLlmMcpAccessStatus();

    return (
      <main className="min-h-screen px-5 py-8 sm:px-8 lg:px-6 lg:py-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          <McpClientsDashboard
            authBasePath={authBasePath}
            clients={clients}
            detailBasePath={`${adminBasePath}/clients`}
            defaultScope={defaultScope}
            connectedProviders={connectedProviders}
            llmAccessStatus={llmAccessStatus.providers}
            llmAccessPath={`${adminBasePath}/llm-access`}
          />
        </div>
      </main>
    );
  }

  async function clientPage(props: { params: Promise<{ clientId: string }> }) {
    await requireMountedAdminSession(options.getSession, handshakeBasePath);
    const { clientId } = await props.params;
    const client = await fetchOAuthClient(options.auth, decodeURIComponent(clientId));

    if (!client) {
      notFound();
    }

    return (
      <main className="min-h-screen px-5 py-8 sm:px-8 lg:px-6 lg:py-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          <McpClientDetailManager
            authBasePath={authBasePath}
            client={client}
            listHref={`${adminBasePath}/clients`}
          />
        </div>
      </main>
    );
  }

  async function consentPage(props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) {
    const searchParams = await props.searchParams;
    const queryString = stringifySearchParams(searchParams);

    await requireMountedSession(options.getSession, handshakeBasePath, queryString);

    const clientId = readFirstSearchParam(searchParams, "client_id");
    const client = clientId ? await fetchOAuthClientPublic(options.auth, clientId) : null;

    return (
      <main className="min-h-screen px-5 py-8 sm:px-8 lg:px-6 lg:py-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          <McpConsentScreen
            authBasePath={authBasePath}
            client={client}
            fallbackHref={adminBasePath}
            queryString={queryString}
          />
        </div>
      </main>
    );
  }

  return {
    Layout: mcpLayout,
    OverviewPage: overviewPage,
    AuthPage: authPage,
    generateAuthStaticParams() {
      return Object.values(authViewPaths).map((path) => ({ path }));
    },
    AccountPage: accountPage,
    generateAccountStaticParams() {
      return Object.values(accountViewPaths).map((path) => ({ path }));
    },
    ClientsPage: clientsPage,
    ClientPage: clientPage,
    ConsentPage: consentPage,
    ConnectivityCheckHandlers: {
      POST: async (request: Request) => {
        const session = await options.getSession();
        if (!session) {
          return NextResponse.redirect(buildSignInHref(handshakeBasePath), { status: 303 });
        }
        if (!isAdminSession(session)) {
          return NextResponse.redirect(new URL("/not-authorized", request.url), { status: 303 });
        }

        const formData = await request.formData();
        const provider = String(formData.get("provider") ?? "").trim() || null;
        const providerParam = provider ? `&provider=${encodeURIComponent(provider)}` : "";
        const settings = await readMountedSettings();
        const publicBaseUrl = settings.publicBaseUrl;
        const redirectTo = (params: string) =>
          NextResponse.redirect(new URL(`${adminBasePath}?${params}${providerParam}`, request.url), { status: 303 });

        if (!publicBaseUrl) {
          return redirectTo("check=no_url");
        }

        try {
          const hostname = new URL(publicBaseUrl).hostname;
          if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
            return redirectTo("check=localhost");
          }
        } catch {
          return redirectTo("check=error");
        }

        const targetUrl = `${publicBaseUrl}${mcpBasePath}`;
        try {
          const res = await fetch(targetUrl, {
            method: "GET",
            signal: AbortSignal.timeout(10_000),
          });
          const wwwAuth = res.headers.get("www-authenticate") ?? "";
          const rawBodyText = await res.text().catch(() => "");
          const truncatedBody = rawBodyText.length > 400 ? `${rawBodyText.slice(0, 400)}…` : rawBodyText;
          const rawPart = `&reqUrl=${encodeURIComponent(targetUrl)}&resStatus=${encodeURIComponent(String(res.status))}&resAuth=${encodeURIComponent(wwwAuth)}&resBody=${encodeURIComponent(truncatedBody)}`;
          if (res.status === 401 && wwwAuth.toLowerCase().includes("bearer")) {
            return redirectTo(`check=ok${rawPart}`);
          } else if (res.status === 401) {
            return redirectTo(`check=no_auth_header${rawPart}`);
          } else {
            return redirectTo(`check=wrong_status&status=${res.status}${rawPart}`);
          }
        } catch (err: unknown) {
          const name = err instanceof Error ? err.name : "";
          if (name === "TimeoutError" || name === "AbortError") {
            return redirectTo("check=timeout");
          }
          return redirectTo("check=error");
        }
      },
    },
    PublicBaseUrlHandlers: {
      POST: async (request: Request) => {
        const session = await options.getSession();
        if (!session) {
          return NextResponse.redirect(buildSignInHref(handshakeBasePath), { status: 303 });
        }
        if (!isAdminSession(session)) {
          return NextResponse.redirect(new URL("/not-authorized", request.url), { status: 303 });
        }

        const formData = await request.formData();
        const publicBaseUrl = normalizeOptionalUrl(String(formData.get("publicBaseUrl") ?? ""));
        await writeMountedSettings({
          publicBaseUrl,
          publicBaseUrlSource: publicBaseUrl ? "manual" : "unknown",
        });

        return NextResponse.redirect(new URL(adminBasePath, request.url), { status: 303 });
      },
    },
    SelfClientHandlers: {
      POST: async (request: Request) => {
        const session = await options.getSession();
        if (!session) {
          return NextResponse.redirect(buildSignInHref(handshakeBasePath), { status: 303 });
        }
        if (!isAdminSession(session)) {
          return NextResponse.redirect(new URL("/not-authorized", request.url), { status: 303 });
        }

        const currentSettings = await readMountedSettings();
        const currentClientId = currentSettings.selfClient?.clientId ?? null;
        const allClients = await fetchOAuthClients(options.auth);
        const selfClientCandidates = allClients.filter((client) => matchesSelfClientCandidate(client, currentClientId));
        const canonicalExistingClient =
          selfClientCandidates.find((client) => client.client_id === SELF_MCP_CLIENT_ID) ??
          selfClientCandidates.find((client) => client.client_id === currentClientId) ??
          selfClientCandidates[0] ??
          null;
        let client: OAuthClientMutationResponse;
        let clientSecret: string | null = null;
        let managedBy: "cli" | "manual" = currentSettings.selfClient?.managedBy ?? "manual";

        if (canonicalExistingClient) {
          if ((canonicalExistingClient.scope?.trim() ?? "") !== SELF_MCP_CLIENT_SCOPE) {
            client = await postOAuthClientMutation<OAuthClientMutationResponse>({
              request,
              authBasePath,
              pathname: "/oauth2/update-client",
              body: {
                client_id: canonicalExistingClient.client_id,
                update: {
                  client_name: SELF_MCP_CLIENT_NAME,
                  redirect_uris: canonicalExistingClient.redirect_uris ?? [],
                  scope: SELF_MCP_CLIENT_SCOPE,
                  type: canonicalExistingClient.type ?? "web",
                },
              },
              fallbackError: "Unable to update the app self-access client.",
            });
          } else {
            client = canonicalExistingClient;
          }

          client = await postOAuthClientMutation<OAuthClientMutationResponse>({
            request,
            authBasePath,
            pathname: "/oauth2/client/rotate-secret",
            body: { client_id: canonicalExistingClient.client_id },
            fallbackError: "Unable to rotate the app self-access client secret.",
          });
          clientSecret = typeof client.client_secret === "string" && client.client_secret.length > 0 ? client.client_secret : null;
        } else {
          client = await postOAuthClientMutation<OAuthClientMutationResponse>({
            request,
            authBasePath,
            pathname: "/oauth2/create-client",
              body: {
                client_name: SELF_MCP_CLIENT_NAME,
                scope: SELF_MCP_CLIENT_SCOPE,
              type: "web",
              public: false,
              grant_types: ["client_credentials"],
              response_types: [],
              token_endpoint_auth_method: "client_secret_basic",
              redirect_uris: [],
            },
            fallbackError: "Unable to create the app self-access client.",
          });
          clientSecret = typeof client.client_secret === "string" && client.client_secret.length > 0 ? client.client_secret : null;
          managedBy = "manual";
        }

        const duplicateClientIds = selfClientCandidates
          .map((candidate) => candidate.client_id)
          .filter((candidateId) => candidateId !== client.client_id);
        for (const duplicateClientId of duplicateClientIds) {
          await deleteOAuthClientById(request, duplicateClientId);
        }

        await writeMountedSettings({
          selfClient: buildSelfClientSettings({
            client,
            clientSecret,
            managedBy,
          }),
        });

        return NextResponse.redirect(new URL(adminBasePath, request.url), { status: 303 });
      },
    },
    LlmAccessHandlers: {
      POST: async (request: Request) => {
        try {
          const session = await options.getSession();
          if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
          if (!isAdminSession(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
          }
          const provider = typeof body === "object" && body !== null && "provider" in body ? String((body as Record<string, unknown>).provider) : "";
          if (!["openai", "anthropic", "gemini"].includes(provider)) {
            return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
          }

          const clientId = `cinatra-llm-${provider}`;
          const clientName = `Cinatra LLM – ${provider.charAt(0).toUpperCase() + provider.slice(1)}`;

          const reqHeaders = await getRequestHeaders();
          const authApi = options.auth.api as Record<string, unknown>;
          const deleteOAuthClientFn = authApi.deleteOAuthClient as
            | ((input: { headers: Headers; body: { client_id: string } }) => Promise<unknown>)
            | undefined;
          const createOAuthClientFn = authApi.createOAuthClient as
            | ((input: { headers: Headers; body: Record<string, unknown> }) => Promise<OAuthClientMutationResponse>)
            | undefined;

          if (!createOAuthClientFn) {
            throw new Error("createOAuthClient API method not available.");
          }

          // Always attempt to delete first (best-effort) so we never hit a
          // duplicate client_id error — then create fresh with a known-good secret.
          await deleteOAuthClientFn?.({ headers: reqHeaders, body: { client_id: clientId } }).catch(() => undefined);
          const client = await createOAuthClientFn({
            headers: reqHeaders,
            body: {
              client_id: clientId,
              client_name: clientName,
              grant_types: ["client_credentials"],
              token_endpoint_auth_method: "client_secret_basic",
              public: false,
              redirect_uris: ["https://localhost/no-redirect"],
              scope: "mcp:connect",
              response_types: [],
            },
          });

          const clientSecret = client.client_secret ?? "";
          writeLlmMcpCredentials(provider, {
            clientId: client.client_id,
            clientSecret,
            clientName,
            scope: "mcp:connect",
            blockedToolPatterns: LLM_BLOCKED_TOOL_PATTERNS,
          });

          return NextResponse.json({ clientId: client.client_id, clientSecret });
        } catch (err) {
          console.error("[LlmAccessHandlers.POST]", err);
          const message = err instanceof Error ? err.message : "Unable to grant LLM access.";
          return NextResponse.json({ error: message }, { status: 500 });
        }
      },

      DELETE: async (request: Request) => {
        const session = await options.getSession();
        if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (!isAdminSession(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
        }
        const provider = typeof body === "object" && body !== null && "provider" in body ? String((body as Record<string, unknown>).provider) : "";
        if (!["openai", "anthropic", "gemini"].includes(provider)) {
          return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
        }

        const creds = getLlmMcpCredentials(provider);
        if (creds) {
          // Best-effort — the OAuth client may not exist in Better Auth
          // (e.g. CLI-provisioned), so ignore deletion errors and always
          // clear the local credentials record.
          await deleteOAuthClientById(request, creds.clientId).catch(() => undefined);
        }
        writeLlmMcpCredentials(provider, null);
        return NextResponse.json({ ok: true });
      },
    },
    TransportHandlers: {
      GET: transportHandler,
      POST: transportHandler,
      DELETE: transportHandler,
      OPTIONS: transportHandler,
    },
    ProtectedResourceMetadataHandlers: {
      GET: protectedResourceMetadataHandler,
      OPTIONS: protectedResourceMetadataHandler,
    },
    AuthorizationServerMetadataHandlers: {
      GET: async (request: Request) =>
        rewriteJsonOriginResponse({
          request,
          response: await authorizationServerMetadataHandler(request),
        }),
    },
    OpenIdConfigurationHandlers: {
      GET: async (request: Request) =>
        rewriteJsonOriginResponse({
          request,
          response: await openIdConfigurationHandler(request),
        }),
    },
  };
}
