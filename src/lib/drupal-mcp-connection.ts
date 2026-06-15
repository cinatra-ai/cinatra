import "server-only";

// Drupal MCP (`drupal/mcp_tools`) probe/status home. The LLM toolbox INJECTION
// of Drupal MCP servers is manifest-driven: the drupal-mcp-connector
// extension's `mcp-toolbox` module builds the injected tools (resolved through
// the generated manifest loader map), consuming this file's probe + endpoint
// helpers via its host-bound deps (the `@cinatra-ai/host:drupal-mcp`
// service published by src/lib/register-host-connector-services.ts).
// This file keeps the host-owned probe used by the connector settings pages.

import { getDrupalAPISettings } from "@/lib/drupal-api";
import { isPrivateUrl } from "@/lib/wordpress-mcp-connection";
import { buildBearerAuthHeaderFromNango } from "@/lib/nango-system";

const MCP_TOOLS_PATH = "/_mcp_tools";

/**
 * Canonical MCP endpoint URL for a Drupal site — the probe target and the
 * INJECTED server URL (the drupal-mcp-connector toolbox consumes it via its
 * host-bound deps; this file owns the route constant).
 */
export function resolveDrupalMcpServerUrl(siteUrl: string): string {
  // Strip trailing slashes via a LINEAR char-index trim. The anchored greedy
  // `/\/+$/` is polynomial-ReDoS on many trailing slashes (CodeQL
  // `js/polynomial-redos`, high) — the codebase standardises on this linear form.
  let end = siteUrl.length;
  while (end > 0 && siteUrl.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return siteUrl.slice(0, end) + MCP_TOOLS_PATH;
}

export type DrupalMcpStatus = "registered" | "not_installed" | "auth_error" | "unreachable";

const PROBE_TTL_MS = 2 * 60 * 1000;
const probeCache = new Map<string, { status: DrupalMcpStatus; expiresAt: number }>();

async function headProbe(endpoint: string, authHeader: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(endpoint, {
        method: "HEAD",
        headers: { Authorization: authHeader },
        signal: controller.signal,
      });
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return 0;
  }
}

function classifyStatus(code: number): DrupalMcpStatus {
  if (code === 200 || code === 405) return "registered"; // 405 = HEAD-not-supported (treat as reachable)
  if (code === 401 || code === 403) return "auth_error";
  if (code === 404) return "not_installed";
  return "unreachable";
}

/**
 * Exported classification of a raw HTTP status into the DrupalMcpStatus the
 * dev-auto-setup reconcile keys its reuse-vs-rotate decision on. Sharing the
 * single classifier here keeps the "only a definite 401/403 = auth_error"
 * boundary in ONE place (it must NEVER drift between the UI status path and the
 * reconcile rotate trigger).
 */
export function classifyDrupalMcpStatus(code: number): DrupalMcpStatus {
  return classifyStatus(code);
}

export async function probeDrupalMcp(
  siteUrl: string,
  authHeader: string,
): Promise<DrupalMcpStatus> {
  const endpoint = resolveDrupalMcpServerUrl(siteUrl);
  const cacheKey = endpoint;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.status;

  const code = await headProbe(endpoint, authHeader);
  const status = classifyStatus(code);
  probeCache.set(cacheKey, { status, expiresAt: Date.now() + PROBE_TTL_MS });
  return status;
}

/**
 * Probe a Drupal `/_mcp_tools` endpoint with an EXPLICIT Bearer token, bypassing
 * the URL-keyed `probeCache` entirely (it always issues a live HEAD). The
 * dev-auto-setup reconcile uses this — its reuse-vs-rotate decision must reflect
 * the CURRENT credential, not a status the cache memoised under a previous
 * (possibly rotated) key. Returns the classified status; never throws.
 */
export async function probeDrupalMcpWithBearer(
  siteUrl: string,
  bearer: string,
): Promise<DrupalMcpStatus> {
  const endpoint = resolveDrupalMcpServerUrl(siteUrl);
  const code = await headProbe(endpoint, `Bearer ${bearer}`);
  return classifyStatus(code);
}

/**
 * Evict the URL-keyed probe-cache entry for a site. The cache is keyed by site
 * URL, NOT by credential, so after a credential rotation a stale `auth_error`
 * (or `registered`) verdict would otherwise be served for up to PROBE_TTL_MS.
 * The reconcile calls this on every rotate so the next UI/injection probe
 * re-evaluates against the fresh key. Idempotent; safe when absent.
 */
export function invalidateDrupalMcpProbeCache(siteUrl: string): void {
  probeCache.delete(resolveDrupalMcpServerUrl(siteUrl));
}

export type DrupalMcpInstanceStatus = {
  id: string;
  name: string;
  siteUrl: string;
  status: DrupalMcpStatus;
  isPrivate: boolean;
};

export async function getDrupalMcpInstanceStatuses(): Promise<DrupalMcpInstanceStatus[]> {
  const { instances } = getDrupalAPISettings();
  const out: DrupalMcpInstanceStatus[] = [];
  for (const instance of instances) {
    const isPrivate = isPrivateUrl(instance.siteUrl);
    if (isPrivate) {
      out.push({ id: instance.id, name: instance.name, siteUrl: instance.siteUrl, status: "registered", isPrivate: true });
      continue;
    }
    // Resolve the Bearer token from Nango per instance.
    const authHeader = await buildBearerAuthHeaderFromNango({
      providerConfigKey: instance.providerConfigKey,
      connectionId: instance.nangoConnectionId,
      label: `drupal-${instance.id}`,
    });
    if (!authHeader) {
      // Helper already warned with the label. Surface as 'unreachable' so
      // the UI status badge clearly distinguishes "no Nango cred" from
      // "Drupal site is down" — both are operator-actionable, but neither
      // reveals the token.
      out.push({ id: instance.id, name: instance.name, siteUrl: instance.siteUrl, status: "unreachable", isPrivate: false });
      continue;
    }
    const status = await probeDrupalMcp(instance.siteUrl, authHeader.Authorization);
    out.push({ id: instance.id, name: instance.name, siteUrl: instance.siteUrl, status, isPrivate: false });
  }
  return out;
}

// NOTE: the LLM toolbox builder that used to live here moved into the
// drupal-mcp-connector extension (`src/mcp/toolbox.ts`, resolved through the
// generated manifest's external-MCP toolbox loader map) — the host no longer
// hardcodes which extensions contribute external MCP tools.
