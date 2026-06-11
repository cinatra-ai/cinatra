import "server-only";

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import { isPrivateUrl } from "@/lib/wordpress-mcp-connection";
import { getNangoCredentials, isNangoConfigured } from "@/lib/nango-system";
import { getMcpPublicBaseUrl } from "@cinatra-ai/mcp-server/credentials";
import type { LlmMcpServerTool } from "@cinatra-ai/llm";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY = "cinatra-external-mcp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Scope enum includes team-scoped rows even though global rows are the only
// rows injected by the registry-wide helper. Admins can create team-scoped
// rows now, and actor-aware paths can honor them where supported.
export type ExternalMcpServerScope = "global" | "org" | "team" | "user" | "workspace";

export type ExternalMcpServerRecord = {
  id: string;
  label: string;
  serverUrl: string;
  nangoConnectionId: string | null;
  scope: ExternalMcpServerScope;
  orgId: string | null;
  userId: string | null;
  enabled: boolean;
  /**
   * Layer A — native MCP allowlist.
   * Filters which native MCP tools (e.g. `execute_tool`, `get_tool_catalog`)
   * are visible to the LLM provider. `null` = no filter, pass through every
   * authorized tool (legacy behavior, preserved for backward compatibility).
   */
  allowedTools: string[] | null;
  /**
   * Layer B — catalog toolName allowlist.
   * Validates the `toolName` argument inside `execute_tool({toolName, arguments})`
   * server-side via `src/lib/external-mcp/twenty-execute-tool-proxy.ts`. Twenty's
   * 244-tool workspace catalog is the load case. `null` = no filter at the proxy
   * layer (no catalog-tool enforcement).
   */
  allowedCatalogTools: string[] | null;
  createdAt: string;
  updatedAt: string;
};

export type ExternalMcpServerUpsertInput = Omit<
  ExternalMcpServerRecord,
  "createdAt" | "updatedAt" | "allowedTools" | "allowedCatalogTools"
> & {
  /** Optional on upsert; defaults to null (legacy "no filter"). */
  allowedTools?: string[] | null;
  /** Optional on upsert; defaults to null (legacy "no filter"). */
  allowedCatalogTools?: string[] | null;
};

// ---------------------------------------------------------------------------
// In-process cache — invalidated on every write
// ---------------------------------------------------------------------------

type CacheShape = { rows: ExternalMcpServerRecord[]; fetchedAt: number } | null;
const CACHE_TTL_MS = 30_000;
const CACHE_KEY = "__cinatraExternalMcpServerCache";
function getCache(): CacheShape {
  return (globalThis as unknown as Record<string, CacheShape>)[CACHE_KEY] ?? null;
}
function setCache(value: CacheShape): void {
  (globalThis as unknown as Record<string, CacheShape>)[CACHE_KEY] = value;
}
function invalidateCache(): void {
  setCache(null);
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type RawRow = {
  id: string;
  label: string;
  server_url: string;
  nango_connection_id: string | null;
  scope: string;
  org_id: string | null;
  user_id: string | null;
  enabled: boolean;
  allowed_tools: string[] | null;
  allowed_catalog_tools: string[] | null;
  created_at: string | Date;
  updated_at: string | Date;
};

function toRecord(row: RawRow): ExternalMcpServerRecord {
  const scope: ExternalMcpServerScope =
    row.scope === "org" ||
    row.scope === "team" ||
    row.scope === "user" ||
    row.scope === "workspace"
      ? row.scope
      : "global";
  return {
    id: row.id,
    label: row.label,
    serverUrl: row.server_url,
    nangoConnectionId: row.nango_connection_id,
    scope,
    orgId: row.org_id,
    userId: row.user_id,
    enabled: row.enabled,
    allowedTools: Array.isArray(row.allowed_tools) ? row.allowed_tools : null,
    allowedCatalogTools: Array.isArray(row.allowed_catalog_tools)
      ? row.allowed_catalog_tools
      : null,
    createdAt: typeof row.created_at === "string" ? row.created_at : row.created_at.toISOString(),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : row.updated_at.toISOString(),
  };
}

function q(text: string) {
  return text.replaceAll('"', '""');
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listExternalMcpServers(): ExternalMcpServerRecord[] {
  const cached = getCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rows;
  }
  ensurePostgresSchema();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, label, server_url, nango_connection_id, scope, org_id, user_id, enabled, allowed_tools, allowed_catalog_tools, created_at, updated_at FROM "${q(postgresSchema)}"."external_mcp_servers" ORDER BY created_at ASC`,
      },
    ],
  });
  const rows = ((result?.rows ?? []) as RawRow[]).map(toRecord);
  setCache({ rows, fetchedAt: Date.now() });
  return rows;
}

export function listEnabledGlobalExternalMcpServers(): ExternalMcpServerRecord[] {
  return listExternalMcpServers().filter(
    (row) => row.enabled && row.scope === "global",
  );
}

export function getExternalMcpServerById(id: string): ExternalMcpServerRecord | null {
  return listExternalMcpServers().find((row) => row.id === id) ?? null;
}

/**
 * Resolve the upstream bearer for an external MCP server row via Nango. Used
 * by both the LLM-side injection (when the row has no catalog allowlist and
 * the bearer is forwarded directly in the Authorization header) and by the
 * host-side Layer B proxy route (when the row has a catalog allowlist and
 * the proxy forwards the bearer server-side after validating the toolName).
 *
 * Returns null when Nango is not configured, the row has no Nango connection,
 * or credential resolution fails. Callers must treat null as "no auth header"
 * (unauthenticated MCP call, upstream returns 401 if it requires auth).
 */
export async function resolveExternalMcpServerBearer(
  row: ExternalMcpServerRecord,
): Promise<string | null> {
  if (!row.nangoConnectionId) return null;
  if (!isNangoConfigured()) return null;
  try {
    const credentials = await getNangoCredentials(
      EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
      row.nangoConnectionId,
    );
    if (credentials && typeof credentials === "object" && "apiKey" in credentials) {
      return (credentials as { apiKey: string }).apiKey;
    }
    if (typeof credentials === "string") {
      return credentials;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decide the URL to inject into the LLM provider's tool definition for an
 * external MCP server. Rows with a non-null `allowedCatalogTools` (Layer B
 * enforcement enabled) route through the cinatra-side proxy at
 * `<publicBaseUrl>/api/external-mcp/proxy/<rowId>` — the proxy validates the
 * `execute_tool` `toolName` against the allowlist before forwarding upstream.
 * Rows with null `allowedCatalogTools` continue to inject the raw
 * `row.serverUrl` (Layer A native MCP allowlist is sufficient on its own).
 *
 * Returns null when proxy-mode is needed but no public base URL is configured
 * — caller must drop the row from the toolbox (fail-closed; better than
 * silently leaking the upstream URL).
 */
export function resolveInjectedMcpServerUrl(
  row: ExternalMcpServerRecord,
  publicBaseUrl: string | null,
): string | null {
  if (row.allowedCatalogTools === null) {
    return row.serverUrl;
  }
  if (!publicBaseUrl) return null;
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/api/external-mcp/proxy/${encodeURIComponent(row.id)}`;
}

export function upsertExternalMcpServer(input: ExternalMcpServerUpsertInput): void {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO "${q(postgresSchema)}"."external_mcp_servers" (id, label, server_url, nango_connection_id, scope, org_id, user_id, enabled, allowed_tools, allowed_catalog_tools, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
               ON CONFLICT (id) DO UPDATE SET
                 label = EXCLUDED.label,
                 server_url = EXCLUDED.server_url,
                 nango_connection_id = EXCLUDED.nango_connection_id,
                 scope = EXCLUDED.scope,
                 org_id = EXCLUDED.org_id,
                 user_id = EXCLUDED.user_id,
                 enabled = EXCLUDED.enabled,
                 allowed_tools = EXCLUDED.allowed_tools,
                 allowed_catalog_tools = EXCLUDED.allowed_catalog_tools,
                 updated_at = now()`,
        values: [
          input.id,
          input.label,
          input.serverUrl,
          input.nangoConnectionId,
          input.scope,
          input.orgId,
          input.userId,
          input.enabled,
          input.allowedTools ?? null,
          input.allowedCatalogTools ?? null,
        ],
      },
    ],
  });
  invalidateCache();
}

export function deleteExternalMcpServer(id: string): void {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `DELETE FROM "${q(postgresSchema)}"."external_mcp_servers" WHERE id = $1`,
        values: [id],
      },
    ],
  });
  invalidateCache();
}

// ---------------------------------------------------------------------------
// Orchestration injection helper
// ---------------------------------------------------------------------------

/**
 * Returns LlmMcpServerTool entries for every enabled global external MCP
 * server in the registry. API keys are retrieved from Nango when available.
 * Private URLs are skipped (LLM providers cannot reach them). Never throws —
 * returns [] on error so LLM calls continue even when the registry is unreachable.
 *
 * Scope note:
 * Only `scope='global'` rows are injected here. Org-, team-, and
 * user-scoped rows exist in the database and appear in the administration UI,
 * but require per-request actor context (not available at adapter-wrap
 * time) to inject.
 */
export async function buildRegisteredExternalMcpServerTools(): Promise<LlmMcpServerTool[]> {
  try {
    const rows = listEnabledGlobalExternalMcpServers();
    const { publicBaseUrl } = getMcpPublicBaseUrl();
    const tools: LlmMcpServerTool[] = [];

    for (const row of rows) {
      if (isPrivateUrl(row.serverUrl)) {
        console.log(
          `[external-mcp-registry] skipping ${row.label} (${row.serverUrl}) — private URL not reachable by LLM provider`,
        );
        continue;
      }

      const injectedUrl = resolveInjectedMcpServerUrl(row, publicBaseUrl);
      if (injectedUrl === null) {
        // Proxy URL required (catalog allowlist present) but public base URL
        // is not configured. Fail-closed: dropping the row from the toolbox
        // is better than leaking the upstream URL bypass-free to the LLM.
        console.warn(
          `[external-mcp-registry] skipping ${row.label} — Layer B catalog allowlist requires a configured public base URL`,
        );
        continue;
      }

      const isProxyMode = injectedUrl !== row.serverUrl;
      let headers: Record<string, string> | undefined;
      // In proxy mode the bearer is resolved + attached server-side by the
      // proxy route; the LLM-facing tool definition stays unauthenticated.
      // Only attach the bearer to the LLM-facing tool when the LLM hits the
      // upstream URL directly (no Layer B catalog allowlist).
      if (!isProxyMode) {
        const bearer = await resolveExternalMcpServerBearer(row);
        if (bearer) headers = { Authorization: `Bearer ${bearer}` };
      }

      tools.push({
        type: "mcp",
        serverLabel: `external-${row.id}`,
        serverUrl: injectedUrl,
        headers,
        serverDescription: `External MCP server: ${row.label}`,
        allowedTools: row.allowedTools,
        requireApproval: "never",
      });
    }
    return tools;
  } catch (err) {
    console.warn(
      "[external-mcp-registry] buildRegisteredExternalMcpServerTools failed — returning empty list",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Build a single LlmMcpServerTool from an external_mcp_servers row id/label.
 * Returns null when the id is not found, the row points to a private URL, or
 * the build fails. Conditional MCP injection paths in registry.ts and index.ts
 * use this when the calling agent declares specific toolbox ids, so per-id
 * resolution logic lives in exactly one place.
 *
 * Lookup order: exact id match, then exact label match. Unmatched ids return
 * null so callers can silently drop them.
 */
export async function buildSingleExternalMcpTool(
  idOrLabel: string,
): Promise<LlmMcpServerTool | null> {
  try {
    const allRows = listExternalMcpServers();
    const row =
      allRows.find((r) => r.id === idOrLabel) ??
      allRows.find((r) => r.label === idOrLabel) ??
      null;
    if (!row) return null;
    // Disabled rows must not be injected even via the explicit-toolbox path.
    // Mirrors the .filter(r => r.enabled) in
    // buildRegisteredExternalMcpServerTools.
    if (!row.enabled) return null;

    // Connector access scope guard. The kernel rejects when the actor cannot
    // read this connector per visibility rules; a missing
    // ALS frame surfaces as ACTOR_CONTEXT_MISSING (fail-closed).
    try {
      const { guardConnectorAccess } = await import("@/lib/connectors-scope-guard");
      const { getActorContextOrThrow } = await import("@cinatra-ai/llm");
      // Fail-closed: every LLM-reachable call must arrive with an actor frame.
      // Calls without one surface as ACTOR_CONTEXT_MISSING (caught below and
      // treated as "drop this tool from the toolbox").
      const actor = getActorContextOrThrow();
      await guardConnectorAccess(row.id, actor);
    } catch (guardErr) {
      const code = (guardErr as Error & { code?: string }).code;
      if (code === "CONNECTOR_ACCESS_DENIED" || code === "ACTOR_CONTEXT_MISSING") {
        console.warn(
          `[external-mcp-registry] guard rejected ${row.label}: ${code}`,
        );
        return null;
      }
      throw guardErr;
    }
    if (isPrivateUrl(row.serverUrl)) {
      console.log(
        `[external-mcp-registry] skipping ${row.label} (${row.serverUrl}) — private URL not reachable by LLM provider`,
      );
      return null;
    }

    const { publicBaseUrl } = getMcpPublicBaseUrl();
    const injectedUrl = resolveInjectedMcpServerUrl(row, publicBaseUrl);
    if (injectedUrl === null) {
      // Proxy URL required (catalog allowlist present) but public base URL
      // is not configured. Fail-closed: drop the row from the toolbox.
      console.warn(
        `[external-mcp-registry] skipping ${row.label} — Layer B catalog allowlist requires a configured public base URL`,
      );
      return null;
    }

    const isProxyMode = injectedUrl !== row.serverUrl;
    let headers: Record<string, string> | undefined;
    if (!isProxyMode) {
      const bearer = await resolveExternalMcpServerBearer(row);
      if (bearer) headers = { Authorization: `Bearer ${bearer}` };
    }

    return {
      type: "mcp",
      serverLabel: `external-${row.id}`,
      serverUrl: injectedUrl,
      headers,
      serverDescription: `External MCP server: ${row.label}`,
      allowedTools: row.allowedTools,
      requireApproval: "never",
    };
  } catch (err) {
    console.warn(
      "[external-mcp-registry] buildSingleExternalMcpTool failed — returning null",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
