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
 * used by the assistant-connector settings pages) and the endpoint resolution.
 * The private-URL policy moved to the neutral `@/lib/url-policy` module
 * (cinatra#975) so the generic external-MCP registry no longer imports a
 * vendor-named module for that neutral concern.
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
 * Strip trailing slashes via a LINEAR char-index trim. The anchored greedy
 * `/\/+$/` is polynomial-ReDoS on input with many trailing slashes (CodeQL
 * `js/polynomial-redos`, high) — the codebase standardises on this linear form.
 */
function trimTrailingSlashes(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return input.slice(0, end);
}

/**
 * Resolve the pretty-permalink MCP endpoint URL for a given WP instance's
 * server route. This is the canonical form shown in the UI and used for the MCP
 * server URL when pretty permalinks are enabled.
 *
 * `restPath` defaults to the grandfathered default-server route
 * (`WP_MCP_ADAPTER_ROUTE`) so every existing caller is behavior-identical
 * (cinatra#2018 S3 — additive per-server generalization). A dedicated server
 * passes its enrolled canonical `/{namespace}/{route}` REST path (leading slash,
 * validated at enrollment time — never caller-influenced at call time).
 */
export function resolveWordPressMcpEndpoint(
  siteUrl: string,
  restPath: string = WP_MCP_ADAPTER_ROUTE,
): string {
  const trimmed = trimTrailingSlashes(siteUrl);
  return `${trimmed}/wp-json${restPath}`;
}

/**
 * Resolve the query-string REST API endpoint for a given WP instance's server
 * route. Used as a fallback probe when pretty permalinks are not enabled, and
 * as the INJECTED server URL (it works in all WP configurations) — the
 * wordpress-mcp-connector toolbox consumes it via its host-bound deps.
 *
 * `restPath` defaults to `WP_MCP_ADAPTER_ROUTE` (existing callers untouched,
 * cinatra#2018 S3); a dedicated server passes its enrolled canonical REST path.
 */
export function resolveWordPressMcpFallbackEndpoint(
  siteUrl: string,
  restPath: string = WP_MCP_ADAPTER_ROUTE,
): string {
  const trimmed = trimTrailingSlashes(siteUrl);
  return `${trimmed}/index.php?rest_route=${restPath}`;
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

/**
 * In-process probe cache, keyed by the canonical PER-SERVER probe URL
 * (`resolveWordPressMcpFallbackEndpoint(siteUrl, restPath)`), NOT the bare
 * siteUrl (cinatra#2018 S3 §7). Per-server keying tracks a dedicated server's
 * reachability independently of the default route's; the key is siteUrl-
 * prefixed so `invalidateWordPressMcpProbeCache` can evict every per-server
 * entry for a site by prefix after a credential rotation.
 */
const probeCache = new Map<string, { status: WordPressMcpAdapterStatus; expiresAt: number }>();
const PROBE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** The canonical, siteUrl-prefixed probe-cache key for a (site, restPath). */
function probeCacheKey(siteUrl: string, restPath: string): string {
  return resolveWordPressMcpFallbackEndpoint(siteUrl, restPath);
}

/**
 * Probe a WP site for mcp-adapter reachability at `restPath`, returning a typed
 * status. Tries the pretty-permalink URL first; if that returns 404 (no pretty
 * permalinks), falls back to the index.php?rest_route= query-string form.
 * Results are cached by the canonical per-server probe URL for 2 minutes. Never
 * throws.
 */
async function probeWordPressMcpServer(
  siteUrl: string,
  restPath: string,
  authHeader: string,
): Promise<WordPressMcpAdapterStatus> {
  const cacheKey = probeCacheKey(siteUrl, restPath);
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.status;

  // Try pretty-permalink form first, then query-string fallback.
  const prettyUrl = resolveWordPressMcpEndpoint(siteUrl, restPath);
  const fallbackUrl = resolveWordPressMcpFallbackEndpoint(siteUrl, restPath);

  let code = await headProbe(prettyUrl, authHeader);
  // If the pretty URL returned 404, the site likely has no pretty permalinks — try fallback.
  if (code === 404) code = await headProbe(fallbackUrl, authHeader);

  const status = classifyStatus(code);
  probeCache.set(cacheKey, { status, expiresAt: Date.now() + PROBE_TTL_MS });
  return status;
}

/**
 * Probe a single WP instance for the DEFAULT mcp-adapter server's status.
 * Exported for the administration UI — returns a typed status rather than a boolean
 * so the UI can show specific guidance per failure mode. Signature/behavior
 * unchanged (cinatra#2018 S3): targets `WP_MCP_ADAPTER_ROUTE`.
 */
export async function probeWordPressInstanceMcpAdapter(
  instance: WordPressMcpProbeTarget,
): Promise<WordPressMcpAdapterStatus> {
  const authHeader = buildBasicAuthHeader(instance);
  return probeWordPressMcpServer(instance.siteUrl, WP_MCP_ADAPTER_ROUTE, authHeader);
}

/**
 * Probe a single WP instance's DEDICATED MCP server route (cinatra#2018 S3 §7).
 * Same HEAD + classify + pretty→fallback sequence as the default-route probe,
 * but keyed by the per-server endpoint so a dedicated server's health is tracked
 * independently. `restPath` MUST be a canonical leading-slash REST path
 * (`/{namespace}/{route}` — validated upstream at enrollment; never caller-
 * influenced at call time). Consumed by the catalog loader / manual-route
 * verification. Returns a typed status; never throws.
 */
export async function probeWordPressInstanceMcpServer(
  instance: WordPressMcpProbeTarget,
  restPath: string,
): Promise<WordPressMcpAdapterStatus> {
  const authHeader = buildBasicAuthHeader(instance);
  return probeWordPressMcpServer(instance.siteUrl, restPath, authHeader);
}

/**
 * Evict the mcp-adapter probe-cache entries for a site. The cache is keyed by
 * the per-server probe URL (siteUrl-prefixed), NOT by credential, so after an
 * application-password rotation a stale `auth_error` verdict would otherwise be
 * served for up to PROBE_TTL_MS. Evicts EVERY per-server entry for the site by
 * prefix (cinatra#2018 S3 §7) so the rotate path clears the default AND all
 * dedicated-server verdicts in one call. The dev-auto-setup reconcile calls this
 * on every WordPress credential rotate so the next probe re-evaluates against
 * the fresh application password. Idempotent; safe when no entry matches.
 */
export function invalidateWordPressMcpProbeCache(siteUrl: string): void {
  // Every cache key is `probeCacheKey(siteUrl, restPath)` =
  // `resolveWordPressMcpFallbackEndpoint(siteUrl, restPath)`, so the empty-path
  // fallback form is — by construction — a prefix of exactly THIS site's keys
  // and of no other site's: a subdirectory install on the same origin keys as
  // `https://site.test/blog/index.php?rest_route=…`, which the
  // `https://site.test/index.php?rest_route=` prefix does not match (codex
  // round-0 High: a bare `${siteUrl}/` prefix over-evicted such siblings).
  const prefix = resolveWordPressMcpFallbackEndpoint(siteUrl, "");
  for (const key of [...probeCache.keys()]) {
    if (key.startsWith(prefix)) probeCache.delete(key);
  }
}

// NOTE: the LLM toolbox builder that used to live here moved into the
// wordpress-mcp-connector extension (`src/mcp/toolbox.ts`, resolved through the
// generated manifest's external-MCP toolbox loader map) — the host no longer
// hardcodes which extensions contribute external MCP tools.
