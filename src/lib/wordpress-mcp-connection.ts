/**
 * WordPress MCP adapter integration — probe/status + URL-policy home.
 *
 * The WordPress/mcp-adapter plugin (https://github.com/WordPress/mcp-adapter)
 * exposes an MCP server at a REST namespace on the WP site. The LLM toolbox
 * INJECTION of those servers is manifest-driven: the wordpress-mcp-connector
 * extension's `mcp-toolbox` module builds the injected tools (resolved through
 * the generated manifest loader map), consuming this file's probe + endpoint
 * helpers via its host-bound deps (the `@cinatra-ai/host:wordpress-mcp`
 * service published by src/lib/register-host-connector-services.ts).
 * This file keeps the host-owned pieces: the cached reachability probe (also
 * used by the assistant-connector settings pages), the endpoint resolution,
 * and the private-URL policy shared with the external-MCP registry.
 *
 * Uses EXISTING connector-wordpress credentials (siteUrl + username +
 * applicationPassword), so no new credential entry is required.
 *
 * The cinatra.php plugin shows an admin notice inside WP admin if
 * mcp-adapter is not active. On the cinatra side, injection silently skips
 * instances where the adapter is not detected.
 *
 * NOTE: The WordPress/mcp-adapter plugin registers under REST namespace "mcp"
 * with route path "/mcp/mcp-adapter-default-server". With pretty permalinks
 * the URL is {siteUrl}/wp-json/mcp/mcp-adapter-default-server; without pretty
 * permalinks (empty permalink_structure) the query-string form is used:
 * {siteUrl}/index.php?rest_route=/mcp/mcp-adapter-default-server.
 */

import "server-only";

import { Buffer } from "node:buffer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * REST route path for the mcp-adapter plugin.
 * Appended after the wp-json base (pretty permalinks) or used in ?rest_route= (no pretty permalinks).
 */
const WP_MCP_ADAPTER_ROUTE = "/mcp/mcp-adapter-default-server";

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the given URL hostname is a private/local address that cannot
 * be reached by external LLM providers (OpenAI, Anthropic). Such sites can still
 * show "Registered" in the administration UI (Cinatra's server can reach them) but must
 * not be registered as external MCP server tools.
 */
export function isPrivateUrl(siteUrl: string): boolean {
  try {
    const { hostname } = new URL(siteUrl);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the pretty-permalink MCP endpoint URL for a given WP instance.
 * This is the canonical form shown in the UI and used for the MCP server URL
 * when pretty permalinks are enabled.
 */
export function resolveWordPressMcpEndpoint(siteUrl: string): string {
  const trimmed = siteUrl.replace(/\/+$/, "");
  return `${trimmed}/wp-json${WP_MCP_ADAPTER_ROUTE}`;
}

/**
 * Resolve the query-string REST API endpoint for a given WP instance.
 * Used as a fallback probe when pretty permalinks are not enabled, and as the
 * INJECTED server URL (it works in all WP configurations) — the
 * wordpress-mcp-connector toolbox consumes it via its host-bound deps.
 */
export function resolveWordPressMcpFallbackEndpoint(siteUrl: string): string {
  const trimmed = siteUrl.replace(/\/+$/, "");
  return `${trimmed}/index.php?rest_route=${WP_MCP_ADAPTER_ROUTE}`;
}

/**
 * True iff a given URL points to a WordPress mcp-adapter endpoint
 * (used by administration UI and diagnostic logging).
 */
export function isWordPressMcpAdapterEndpoint(url: string): boolean {
  return url.includes(WP_MCP_ADAPTER_ROUTE);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * The credential fields the probe needs from a WP instance (structural subset
 * of `WordPressInstanceSettings` so the host can bind the probe into the
 * wordpress-mcp-connector deps without widening to the full settings shape).
 */
export type WordPressMcpProbeTarget = {
  siteUrl: string;
  username: string;
  applicationPassword: string;
};

/**
 * Build the HTTP Basic auth header value from a WP instance's credentials.
 * The mcp-adapter plugin authenticates using the same WordPress Application
 * Passwords scheme that the existing connector-wordpress REST client uses.
 */
function buildBasicAuthHeader(instance: WordPressMcpProbeTarget): string {
  const credentials = `${instance.username}:${instance.applicationPassword}`;
  const encoded = Buffer.from(credentials, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/** Status of a WP MCP adapter probe. */
export type WordPressMcpAdapterStatus =
  | "registered"    // endpoint reachable and auth accepted
  | "not_installed" // endpoint returned 404 — plugin not active on this site
  | "auth_error"    // endpoint exists (405/2xx without auth OR 401/403 with auth) — credential issue
  | "unreachable";  // timeout or network error

/**
 * Try a HEAD request to `endpoint`. Returns the HTTP status code, or 0 on network error.
 * Never throws.
 */
async function headProbe(endpoint: string, authHeader: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(endpoint, {
      method: "HEAD",
      headers: { Authorization: authHeader },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.status;
  } catch {
    return 0;
  }
}

/**
 * Classify a probe status code into a WordPressMcpAdapterStatus.
 * 200/405 = registered (405 = endpoint exists, HEAD not supported by plugin).
 * 401/403 = auth_error.
 * 404 = not_installed.
 * 0 = unreachable.
 * Anything else = unreachable.
 */
function classifyStatus(code: number): WordPressMcpAdapterStatus {
  if (code === 200 || code === 405) return "registered";
  if (code === 401 || code === 403) return "auth_error";
  if (code === 404) return "not_installed";
  return "unreachable";
}

/** In-process probe cache: siteUrl → { status, expiresAt } */
const probeCache = new Map<string, { status: WordPressMcpAdapterStatus; expiresAt: number }>();
const PROBE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Probe a WP site for mcp-adapter reachability, returning a typed status.
 * Tries the pretty-permalink URL first; if that returns 404 (no pretty permalinks),
 * falls back to the index.php?rest_route= query-string form.
 * Results are cached by siteUrl for 2 minutes. Never throws.
 */
async function probeWordPressMcpAdapter(
  siteUrl: string,
  authHeader: string,
): Promise<WordPressMcpAdapterStatus> {
  const cacheKey = siteUrl;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.status;

  // Try pretty-permalink form first, then query-string fallback.
  const prettyUrl = resolveWordPressMcpEndpoint(siteUrl);
  const fallbackUrl = resolveWordPressMcpFallbackEndpoint(siteUrl);

  let code = await headProbe(prettyUrl, authHeader);
  // If the pretty URL returned 404, the site likely has no pretty permalinks — try fallback.
  if (code === 404) code = await headProbe(fallbackUrl, authHeader);

  const status = classifyStatus(code);
  probeCache.set(cacheKey, { status, expiresAt: Date.now() + PROBE_TTL_MS });
  return status;
}

/**
 * Probe a single WP instance for mcp-adapter status.
 * Exported for the administration UI — returns a typed status rather than a boolean
 * so the UI can show specific guidance per failure mode.
 */
export async function probeWordPressInstanceMcpAdapter(
  instance: WordPressMcpProbeTarget,
): Promise<WordPressMcpAdapterStatus> {
  const authHeader = buildBasicAuthHeader(instance);
  return probeWordPressMcpAdapter(instance.siteUrl, authHeader);
}

// NOTE: the LLM toolbox builder that used to live here moved into the
// wordpress-mcp-connector extension (`src/mcp/toolbox.ts`, resolved through the
// generated manifest's external-MCP toolbox loader map) — the host no longer
// hardcodes which extensions contribute external MCP tools.
