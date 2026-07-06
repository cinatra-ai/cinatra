import "server-only";

// Drupal MCP (`drupal/mcp_tools`) probe/status home. The LLM toolbox INJECTION
// of Drupal MCP servers is manifest-driven: the drupal-mcp-connector
// extension's `mcp-toolbox` module builds the injected tools (resolved through
// the generated manifest loader map), consuming this file's probe + endpoint
// helpers via its host-bound deps (the `@cinatra-ai/host:drupal-mcp`
// service published by src/lib/register-host-connector-services.ts).
// This file keeps the host-owned probe used by the connector settings pages.

// The Drupal instance store is CONNECTOR-owned since cinatra#975 Wave 3 —
// the status sweep resolves the relocated client lazily and degrades to an
// EMPTY sweep (no instances) when the owning connector is absent (nothing to
// probe for a store that does not exist).
import { resolveDrupalInstanceAdmin } from "@/lib/connector-client-providers";
import { isPrivateUrl } from "@/lib/url-policy";
import { buildBearerAuthHeaderFromNango } from "@/lib/nango-system";
import { enforceInstanceConnectionUse } from "@/lib/instance-connection-actor";

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
  const instances = resolveDrupalInstanceAdmin()?.listInstances() ?? [];
  const out: DrupalMcpInstanceStatus[] = [];
  for (const instance of instances) {
    const isPrivate = isPrivateUrl(instance.siteUrl);
    if (isPrivate) {
      out.push({ id: instance.id, name: instance.name, siteUrl: instance.siteUrl, status: "registered", isPrivate: true });
      continue;
    }
    // Owner-aware resolver routing (cinatra#967, W3 residue): resolve
    // (self-heal seeding when absent) the instance's identity row and gate +
    // audit this credential use through the W2 use-gate, with the
    // configuring admin (or an org-bound InternalWorker) threaded as the
    // acting actor. An instance whose identity cannot be resolved/seeded at
    // all falls back to the pre-#967 ungated probe — never a regression. A
    // DENIED gate must not abort the WHOLE status sweep (other instances'
    // statuses are independent) — surface it as 'auth_error', the same
    // status code path a live 401/403 from the site itself would classify
    // to. Only `ConnectionUseDeniedError` is downgraded this way; anything
    // else (a DB error, an identity conflict, an audit-write failure) is a
    // genuine anomaly and must stay LOUD — rethrown, not silently swallowed
    // into a misleading status code (codex round-0 finding).
    try {
      await enforceInstanceConnectionUse({
        connectorKey: "drupal",
        connectionId: instance.nangoConnectionId,
        binding: { orgId: instance.orgId, runBy: instance.runBy },
        source: "drupal-mcp-connection",
      });
    } catch (err) {
      const { ConnectionUseDeniedError } = await import("@/lib/connection-use-gate");
      if (!(err instanceof ConnectionUseDeniedError)) {
        throw err;
      }
      console.warn(
        `[drupal-mcp-connection] use-gate denied for instance ${instance.id} (surfaced as auth_error):`,
        err.message,
      );
      out.push({ id: instance.id, name: instance.name, siteUrl: instance.siteUrl, status: "auth_error", isPrivate: false });
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
