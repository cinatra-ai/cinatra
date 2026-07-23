import "server-only";

import { createHash } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import { isPrivateUrl } from "@/lib/url-policy";
import {
  getNangoCredentials,
  isNangoConfigured,
  ensureNangoIntegration,
  importNangoConnection,
  deleteNangoConnection,
} from "@/lib/nango-system";
import { getMcpPublicBaseUrl } from "@cinatra-ai/mcp-server/credentials";
import type { LlmMcpServerTool } from "@cinatra-ai/llm";
import { resolveWordPressInstanceAdmin } from "@/lib/connector-client-providers";
import {
  resolveWordPressMcpEndpoint,
  resolveWordPressMcpFallbackEndpoint,
} from "@/lib/wordpress-mcp-connection";

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

// ---------------------------------------------------------------------------
// Transport vocabulary (llm-providers S2, #1713). The MCP wire transport a
// server speaks, persisted as first-class data so the injection layer never
// INFERS transport from an HTTP URL (Gemini's documented MCP is
// Streamable-HTTP-only, but the rule stands on its own for every provider).
//   - "streamable-http" → the modern MCP Streamable HTTP transport.
//   - "sse"             → the legacy HTTP+SSE transport.
//   - "unknown"         → transport not classified. LEGACY rows (written before
//                         this column existed) and any unrecognized stored value
//                         land here; the adapter-facing injection refusal (wired
//                         in the post-#1707 adapter half) fails closed against
//                         "unknown" for providers whose declared capability does
//                         not accept it.
// ---------------------------------------------------------------------------
export const EXTERNAL_MCP_TRANSPORTS = ["streamable-http", "sse", "unknown"] as const;
export type ExternalMcpServerTransport = (typeof EXTERNAL_MCP_TRANSPORTS)[number];

/**
 * Coerce a raw stored / caller-supplied transport value to the closed
 * vocabulary. Any value that is not exactly `"streamable-http"` or `"sse"`
 * classifies as `"unknown"` — this is the single place legacy rows (a NULL /
 * absent column before the S2 migration) and unrecognized values become
 * `"unknown"`, fail-closed. Never infers from the URL.
 */
export function normalizeExternalMcpTransport(value: unknown): ExternalMcpServerTransport {
  return value === "streamable-http" || value === "sse" ? value : "unknown";
}

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
   * MCP wire transport this server speaks (llm-providers S2, #1713). Legacy
   * rows classify as `"unknown"` (the migration backfills the column default);
   * `toRecord` coerces any unexpected stored value through
   * `normalizeExternalMcpTransport`. Persisted end-to-end so the injection
   * layer never infers transport from the URL.
   */
  transport: ExternalMcpServerTransport;
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
  "createdAt" | "updatedAt" | "allowedTools" | "allowedCatalogTools" | "transport"
> & {
  /** Optional on upsert; defaults to null (legacy "no filter"). */
  allowedTools?: string[] | null;
  /** Optional on upsert; defaults to null (legacy "no filter"). */
  allowedCatalogTools?: string[] | null;
  /**
   * Optional on upsert; defaults to `"unknown"` (llm-providers S2, #1713). An
   * operator write surface may set it explicitly; an omitted value persists
   * `"unknown"` — the transport is never inferred from `serverUrl`.
   */
  transport?: ExternalMcpServerTransport;
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
  transport: string | null;
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
    transport: normalizeExternalMcpTransport(row.transport),
    createdAt: typeof row.created_at === "string" ? row.created_at : row.created_at.toISOString(),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : row.updated_at.toISOString(),
  };
}

function q(text: string) {
  return text.replaceAll('"', '""');
}

// ---------------------------------------------------------------------------
// Managed-endpoint containment (cinatra#2015 S0 deliverable 3)
//
// Managed and BYO registrations of the same site endpoint must not coexist:
// a BYO `external_mcp_servers` row pointed at an endpoint a managed connector
// instance already owns would inject the same server twice (label collision at
// best, a second credential path at worst). Every registry write refuses such
// a row, and a once-per-process sweep disables pre-existing matches
// (audit-warn + admin notification). BYO rows for unrelated servers are
// untouched — this is containment, not capability-hiding.
// ---------------------------------------------------------------------------

/**
 * Canonicalize an MCP endpoint URL so equivalent forms compare equal:
 * scheme+host lower-cased, default ports dropped, trailing slashes trimmed,
 * and the WordPress query-string endpoint form
 * (`/index.php?rest_route=/R`) folded onto its pretty-permalink twin
 * (`/wp-json/R`). Paths stay case-sensitive. Returns null for anything that
 * is not an absolute http(s) URL.
 */
export function canonicalizeMcpEndpointUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const scheme = url.protocol.slice(0, -1);
  const host = url.hostname.toLowerCase();
  const defaultPort = scheme === "https" ? "443" : "80";
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : "";
  let path = url.pathname.replace(/\/+$/, "");
  const params = new URLSearchParams(url.search);
  const restRoute = params.get("rest_route");
  if (restRoute && path.endsWith("/index.php")) {
    path = `${path.slice(0, -"/index.php".length)}/wp-json${restRoute.replace(/\/+$/, "")}`;
    params.delete("rest_route");
  }
  params.sort();
  const query = params.toString();
  return `${scheme}://${host}${port}${path}${query ? `?${query}` : ""}`;
}

export class ExternalMcpServerManagedEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalMcpServerManagedEndpointError";
  }
}

/**
 * Canonical URLs of every endpoint a managed connector instance owns. Today
 * that is the WordPress connector's mcp-adapter endpoint per instance (both
 * URL forms canonicalize to one key); later gateway slices extend this as
 * more managed MCP surfaces appear. Absent provider (extension not active)
 * ⇒ empty set — there is nothing managed to protect.
 */
function managedConnectorEndpointCanonicalUrls(): Set<string> {
  const out = new Set<string>();
  try {
    const admin = resolveWordPressInstanceAdmin();
    if (!admin) return out;
    for (const instance of admin.listInstances()) {
      const siteUrl = (instance as { siteUrl?: unknown }).siteUrl;
      if (typeof siteUrl !== "string" || siteUrl === "") continue;
      for (const endpoint of [
        resolveWordPressMcpEndpoint(siteUrl),
        resolveWordPressMcpFallbackEndpoint(siteUrl),
      ]) {
        const canonical = canonicalizeMcpEndpointUrl(endpoint);
        if (canonical) out.add(canonical);
      }
    }
  } catch (err) {
    // Fail-open for ENUMERATION only: a broken provider must not take the
    // whole BYO registry down. The write-path check simply sees fewer managed
    // endpoints; the sweep re-runs next process.
    console.warn(
      "[external-mcp-registry] managed-endpoint enumeration failed — containment check degraded this process",
      err instanceof Error ? err.message : String(err),
    );
  }
  return out;
}

/** Refuse a BYO row targeting an endpoint a managed connector instance owns. */
function assertNotManagedConnectorEndpoint(serverUrl: string): void {
  const canonical = canonicalizeMcpEndpointUrl(serverUrl);
  if (canonical === null) return; // URL validity is the callers' concern
  if (managedConnectorEndpointCanonicalUrls().has(canonical)) {
    throw new ExternalMcpServerManagedEndpointError(
      "This endpoint is already managed by a connected site's connector instance — " +
        "it cannot also be registered as an external MCP server. Manage it through the connector instead.",
    );
  }
}

let managedEndpointSweepDone = false;

/**
 * Once-per-process migration sweep: disable pre-existing ENABLED rows whose
 * canonical URL matches a managed connector endpoint. Each disabled row is
 * audit-warned; platform admins get one notification naming the rows. Runs
 * lazily off the first uncached list read; a failure is warned and retried on
 * the next process, never thrown into the read path.
 */
function sweepManagedEndpointRows(rows: ExternalMcpServerRecord[]): void {
  const managed = managedConnectorEndpointCanonicalUrls();
  if (managed.size === 0) return;
  const matches = rows.filter((row) => {
    if (!row.enabled) return false;
    const canonical = canonicalizeMcpEndpointUrl(row.serverUrl);
    return canonical !== null && managed.has(canonical);
  });
  if (matches.length === 0) return;
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${q(postgresSchema)}"."external_mcp_servers" SET enabled = false, updated_at = now() WHERE id = ANY($1)`,
        values: [matches.map((row) => row.id)],
      },
    ],
  });
  for (const row of matches) {
    (row as { enabled: boolean }).enabled = false;
    console.warn(
      `[external-mcp-registry] AUDIT: disabled BYO external MCP server "${row.label}" (${row.id}) — ` +
        `its endpoint ${row.serverUrl} is owned by a managed connector instance (cinatra#2015 S0 sweep).`,
    );
  }
  // Session-less context → createNotification falls back to platform admins.
  void import("@/lib/notifications")
    .then(({ createNotification }) =>
      createNotification({
        title: "External MCP servers disabled",
        body:
          `${matches.length} externally registered MCP server${matches.length === 1 ? " was" : "s were"} ` +
          `disabled because ${matches.length === 1 ? "its endpoint is" : "their endpoints are"} already ` +
          `managed by a connected site: ${matches.map((row) => `"${row.label}"`).join(", ")}. ` +
          "Manage those sites through their connector instead.",
      }),
    )
    .catch((err) => {
      console.warn(
        "[external-mcp-registry] sweep notification failed",
        err instanceof Error ? err.message : String(err),
      );
    });
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
        text: `SELECT id, label, server_url, nango_connection_id, scope, org_id, user_id, enabled, allowed_tools, allowed_catalog_tools, transport, created_at, updated_at FROM "${q(postgresSchema)}"."external_mcp_servers" ORDER BY created_at ASC`,
      },
    ],
  });
  const rows = ((result?.rows ?? []) as RawRow[]).map(toRecord);
  if (!managedEndpointSweepDone) {
    managedEndpointSweepDone = true;
    try {
      sweepManagedEndpointRows(rows);
    } catch (err) {
      console.warn(
        "[external-mcp-registry] managed-endpoint sweep failed — retried next process",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
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
 * TOCTOU-safe authorization read (Refs cinatra#658). `getExternalMcpServerById`
 * serves from the in-process 30s TTL cache (`listExternalMcpServers`), which is
 * invalidated ONLY on in-process writes — so under cross-worker staleness it can
 * return a row whose scope/owner has since changed (e.g. an admin promoted the
 * actor's own row to `global` on another worker). A privileged write action that
 * authorizes against that stale row and then writes unconditionally by id would
 * defeat the "global requires admin" / "modify your own" invariant.
 *
 * This reads the single row DIRECTLY from the database, bypassing AND not
 * populating the cache, so the pre-write authorization decision sees the current
 * row. (It is paired with the guarded compare-and-write helpers below; the fresh
 * read alone narrows but does not eliminate the window — the conditional write
 * closes it atomically.) Returns null when the row does not exist.
 */
export function getExternalMcpServerByIdFresh(id: string): ExternalMcpServerRecord | null {
  ensurePostgresSchema();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, label, server_url, nango_connection_id, scope, org_id, user_id, enabled, allowed_tools, allowed_catalog_tools, transport, created_at, updated_at FROM "${q(postgresSchema)}"."external_mcp_servers" WHERE id = $1 LIMIT 1`,
        values: [id],
      },
    ],
  });
  const rows = (result?.rows ?? []) as RawRow[];
  return rows.length > 0 ? toRecord(rows[0]) : null;
}

/** Gate one external-MCP row's connection use (cinatra#952 W2). Returns true
 * when the use-gate ALLOWS; false when the identity row is missing or the
 * gate denies (both fail closed to "no bearer"). Deny/allow are audited by
 * the gate; the deny row is durable + flood-controlled and lands BEFORE this
 * returns. */
async function gateExternalMcpConnectionUse(row: ExternalMcpServerRecord): Promise<boolean> {
  if (!row.nangoConnectionId) return false;
  const { readNangoConnectionByNaturalKey } = await import(
    "@cinatra-ai/extensions/connection-identity-store"
  );
  const { enforceConnectionUse, ConnectionUseDeniedError } = await import(
    "@/lib/connection-use-gate"
  );
  const { POLICY_VERSION } = await import("@/lib/authz/actor-context");
  const identity = await readNangoConnectionByNaturalKey("externalMcp", row.nangoConnectionId);
  if (!identity) return false;
  // A user-scoped (personal) row mints ONLY for its owner (cinatra#1407): resolve
  // the current human subject from the trusted context and let the gate's OWN
  // short-circuit (subjectUserId === identity.ownerUserId) authorize the mint for
  // the InternalWorker acting on the owner's behalf. A non-owner subject — or no
  // trusted subject (e.g. a server-side path with no human actor) — leaves
  // subjectUserId undefined and falls through to the owner-only grant, which
  // DENIES (defense-in-depth: an owner's personal key never mints for another
  // actor). Global/shared rows keep subjectUserId undefined and mint via their
  // org/workspace grant exactly as before (unchanged).
  let subjectUserId: string | undefined;
  if (row.scope === "user") {
    try {
      const { resolveExtensionActorSummary } = await import("@/lib/extension-host-actor");
      subjectUserId = (await resolveExtensionActorSummary())?.userId ?? undefined;
    } catch {
      subjectUserId = undefined;
    }
  }
  try {
    await enforceConnectionUse({
      identity,
      actor: {
        principalType: "InternalWorker",
        principalId: `worker:external-mcp:${row.id}`,
        organizationId: identity.organizationId ?? undefined,
        teamIds: [],
        projectGrants: [],
        projectIds: [],
        authSource: "worker",
        policyVersion: POLICY_VERSION,
      },
      subjectUserId,
      source: "external-mcp-registry",
    });
    return true;
  } catch (err) {
    if (err instanceof ConnectionUseDeniedError) return false;
    throw err;
  }
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
  // Per-connection use-gate (cinatra#952 W2, external-MCP identity special
  // case): external-MCP connections carry identity rows (connector_key
  // "externalMcp") but NO blob pointer record — they are connection-ADDRESSED
  // (use-gate only; no candidate selection; no blob lookup). The mint is
  // audited as an InternalWorker BOUND to the identity row's organization. A
  // missing identity row (pre-seed deployments run core__0015) or a deny
  // fails CLOSED into the callers' `null = no auth header` contract — no
  // credential is ever fetched past a deny.
  const gated = await gateExternalMcpConnectionUse(row);
  if (!gated) return null;
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
 * Persist an API key for a setup-page-created external MCP server into the
 * connection service (Nango), readback-verified, under the SHARED external-MCP
 * provider key — the SANCTIONED credential path (cinatra#1407 defect 1). The
 * setup-page create/upsert handler stores the returned connection id on the row
 * so the connector's `apiKeyConfigured` (nangoConnectionId != null) becomes true
 * and `resolveExternalMcpServerBearer` can later mint the bearer. Mirrors the
 * Twenty connect flow's import+readback step (`saveTwentyConnection`), minus the
 * Twenty-specific live probe (a generic MCP server has no standard probe URL).
 *
 * SECURITY: never logs, echoes, or returns the key; every failure throws a
 * GENERIC message (no key / no readback value in it) so a caller-side log of the
 * error cannot leak secret content. Fail-closed: throws when Nango is
 * unconfigured — the key MUST NOT be silently dropped (the connector advisory
 * promises "API keys are stored securely via the connection service").
 *
 * @param connectionId the Nango connection id to store under — the caller mints a
 *   UNIQUE id per write (so a rejected write never overwrites/cross-wires a
 *   credential another row still references) and rolls it back on failure.
 * @param apiKey the raw key, already trimmed + validated non-empty by the caller.
 * @param identity owner/org + grant seed for the `externalMcp` connection-identity
 *   row. REQUIRED because `gateExternalMcpConnectionUse` fails closed without a
 *   live identity — the stored key would never mint a bearer (apiKeyConfigured
 *   would be a lie). `seed:"owner"` for a per-user row (never auto-shares);
 *   `seed:"workspace"` for a shared (global) row minted by an org-bound
 *   InternalWorker an owner-only grant would deny. Mirrors saveTwentyConnection.
 */
export async function importExternalMcpApiKeyConnection(
  connectionId: string,
  apiKey: string,
  identity: { ownerUserId: string; organizationId: string | null; seed: "owner" | "workspace" },
): Promise<void> {
  if (!isNangoConfigured()) {
    throw new Error(
      "The connection service (Nango) is not configured — an administrator must configure it before an API key can be stored.",
    );
  }
  let readbackKey: unknown = null;
  try {
    // `private-api-bearer` is the generic Bearer-token template the shared
    // external-MCP provider uses (matches the Twenty import + the dev-auto-setup
    // mint under EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY, which `resolveBearer` reads).
    await ensureNangoIntegration({
      provider: "private-api-bearer",
      providerConfigKey: EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
      displayName: "Cinatra External MCP",
    });
    await importNangoConnection({
      providerConfigKey: EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
      connectionId,
      credentials: { type: "API_KEY", apiKey },
    });
    // Readback-verify the write actually landed, so a silent connection-service
    // failure fails CLOSED instead of leaving a row that claims a key it can't mint.
    const readback = await getNangoCredentials(EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY, connectionId, {
      forceRefresh: true,
    });
    readbackKey =
      readback && typeof readback === "object" && "apiKey" in readback
        ? (readback as { apiKey?: unknown }).apiKey
        : null;
  } catch {
    // Map ANY connection-service failure to a GENERIC message — a vault error can
    // carry request payload, and this error propagates to the caller/log sink.
    throw new Error("The connection service could not store the API key. Please try again.");
  }
  if (readbackKey !== apiKey) {
    throw new Error(
      "The connection service did not store the API key correctly (readback mismatch). Please try again.",
    );
  }
  // Seed the `externalMcp` connection identity + one-time grant so the use-gate
  // can mint the bearer (a unique connectionId per write never collides with a
  // foreign identity row). A throw here leaves the credential written — the caller
  // rolls it back via `revokeExternalMcpApiKeyConnection`.
  const { registerSavedConnectionIdentity } = await import("@/lib/connection-identity-seam");
  await registerSavedConnectionIdentity({
    connectorKey: "externalMcp",
    connectionId,
    ownerUserId: identity.ownerUserId,
    organizationId: identity.organizationId,
    seed: identity.seed,
  });
}

/**
 * Revoke a setup-page-created external MCP server's stored API key + identity
 * when its row is deleted or a write is rolled back (cinatra#1407 defect 1).
 * Ordered like `disconnectTwentyConnection`/`revokeConnection`: soft-delete the
 * `externalMcp` IDENTITY row FIRST (revocation-next-use — the use-gate fails
 * closed immediately), then best-effort delete the upstream Nango token. NEVER
 * throws — the row (the only pointer to the credential) is already gone or was
 * never committed, so a residual credential is unreachable; each step is logged
 * NON-SECRETLY (the key value is never in scope for a delete) and swallowed.
 * No-op on an empty id. `deleteNangoConnection` already no-ops when Nango is
 * unconfigured, so no separate `isNangoConfigured` guard is needed.
 */
export async function revokeExternalMcpApiKeyConnection(
  connectionId: string | null | undefined,
): Promise<void> {
  if (!connectionId) return;
  try {
    const { readNangoConnectionByNaturalKey, softDeleteNangoConnection } = await import(
      "@cinatra-ai/extensions/connection-identity-store"
    );
    const identity = await readNangoConnectionByNaturalKey("externalMcp", connectionId);
    if (identity) await softDeleteNangoConnection(identity.id);
  } catch (err) {
    console.warn(
      "[external-mcp-registry] best-effort api-key identity revoke failed",
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    await deleteNangoConnection(EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY, connectionId);
  } catch (err) {
    console.warn(
      "[external-mcp-registry] best-effort api-key connection delete failed",
      err instanceof Error ? err.message : String(err),
    );
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
  assertNotManagedConnectorEndpoint(input.serverUrl);
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO "${q(postgresSchema)}"."external_mcp_servers" (id, label, server_url, nango_connection_id, scope, org_id, user_id, enabled, allowed_tools, allowed_catalog_tools, transport, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
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
                 transport = EXCLUDED.transport,
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
          input.transport ?? "unknown",
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
// TOCTOU-safe guarded writes (Refs cinatra#658)
//
// The privileged write actions (`createExternalMcpServerAction` /
// `deleteExternalMcpServerAction` and the `createServerHandler` /
// `deleteServerHandler` connector-setup bindings) authorize against a row, then
// mutate by id. The plain helpers above mutate UNCONDITIONALLY by id, so a row
// that changed scope/owner between the authorization read and the write (cache
// staleness across workers + a concurrent admin promotion) could be
// overwritten/deleted in violation of the authorized precondition.
//
// These helpers make the mutation CONDITIONAL on the row STILL matching the
// witnessed (authorized) scope+owner, so the write is atomic with the
// re-validated precondition. They throw `ExternalMcpServerWriteConflictError`
// when the row no longer matches (changed or vanished) — the caller treats that
// as an authorization denial (fail-closed), NEVER as a best-effort write.
// ---------------------------------------------------------------------------

/** Thrown by the guarded writes when the row no longer matches the authorized
 *  scope/owner at write time (the TOCTOU race fired). Fail-closed: callers map
 *  this to a "not authorized" denial, never a silent best-effort mutation. */
export class ExternalMcpServerWriteConflictError extends Error {
  constructor(message = "External MCP server changed under the authorized operation.") {
    super(message);
    this.name = "ExternalMcpServerWriteConflictError";
  }
}

/** The witnessed scope+owner the authorization decision was made against. The
 *  guarded write only proceeds if the row STILL matches this. */
export type ExternalMcpServerGuard = {
  scope: ExternalMcpServerScope;
  userId: string | null;
  /**
   * Optional compare-and-write witness of the row's CURRENT `nango_connection_id`
   * (cinatra#1407). When provided (a `string` or `null`), the guarded write/delete
   * ALSO requires the row's stored connection to still match the witnessed value —
   * so a concurrent re-key or keyless edit that changed the connection between the
   * fresh authz read and this write FAILS CLOSED (conflict) instead of resurrecting
   * a revoked pointer, orphaning a credential, or landing a row that advertises a
   * key it cannot mint. Omitted (`undefined`) keeps the legacy scope+owner-only
   * guard — the campaigns server actions, which do not manage the key column, omit
   * it (backward compatible).
   */
  nangoConnectionId?: string | null;
};

/**
 * Strict INSERT of a BRAND-NEW row (Refs cinatra#658). Unlike
 * `upsertExternalMcpServer`, this NEVER updates an existing row: `ON CONFLICT
 * (id) DO NOTHING RETURNING id` makes a colliding id a no-op, and a zero-row
 * result is surfaced as a conflict. This closes the residual race where a
 * caller-supplied id resolves to "no row" on the fresh authz read but is created
 * by a concurrent worker before this insert — the plain upsert would have
 * silently clobbered it. (Detecting the conflict via `rowCount` is reliable
 * without relying on the sync worker to propagate the pg duplicate-key code.)
 */
export function insertExternalMcpServerStrict(input: ExternalMcpServerUpsertInput): void {
  assertNotManagedConnectorEndpoint(input.serverUrl);
  ensurePostgresSchema();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO "${q(postgresSchema)}"."external_mcp_servers" (id, label, server_url, nango_connection_id, scope, org_id, user_id, enabled, allowed_tools, allowed_catalog_tools, transport, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
               ON CONFLICT (id) DO NOTHING
               RETURNING id`,
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
          input.transport ?? "unknown",
        ],
      },
    ],
  });
  if ((result?.rowCount ?? 0) === 0) {
    throw new ExternalMcpServerWriteConflictError(
      "An external MCP server with this id already exists.",
    );
  }
  invalidateCache();
}

/**
 * Guarded UPDATE of an EXISTING row (Refs cinatra#658). Sets the caller's
 * DESIRED final column values, but only if the row STILL matches the witnessed
 * `expected` scope+owner — so a row promoted/re-owned/deleted between the authz
 * read and this write fails closed instead of being clobbered. A legitimate
 * admin promotion (e.g. user->global) still works: the guard matches the
 * witnessed `scope='user'`+owner, and the SET applies the new scope.
 *
 * `user_id IS NOT DISTINCT FROM $expectedUserId` is the NULL-safe equality the
 * global/shared rows (NULL owner) require. When `expected.nangoConnectionId` is
 * provided, the row's CURRENT connection must ALSO still match (NULL-safe) — a
 * concurrent re-key/keyless-edit that moved the connection fails closed instead
 * of resurrecting a revoked pointer (cinatra#1407). Throws
 * `ExternalMcpServerWriteConflictError` on a zero-row match.
 */
export function updateExternalMcpServerGuarded(
  input: ExternalMcpServerUpsertInput,
  expected: ExternalMcpServerGuard,
): void {
  assertNotManagedConnectorEndpoint(input.serverUrl);
  ensurePostgresSchema();
  const witnessNango = expected.nangoConnectionId !== undefined;
  const values: unknown[] = [
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
    input.transport ?? "unknown",
    expected.scope,
    expected.userId,
  ];
  if (witnessNango) values.push(expected.nangoConnectionId ?? null);
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${q(postgresSchema)}"."external_mcp_servers" SET
                 label = $2,
                 server_url = $3,
                 nango_connection_id = $4,
                 scope = $5,
                 org_id = $6,
                 user_id = $7,
                 enabled = $8,
                 allowed_tools = $9,
                 allowed_catalog_tools = $10,
                 transport = $11,
                 updated_at = now()
               WHERE id = $1
                 AND scope = $12
                 AND user_id IS NOT DISTINCT FROM $13${
                   witnessNango ? "\n                 AND nango_connection_id IS NOT DISTINCT FROM $14" : ""
                 }
               RETURNING id`,
        values,
      },
    ],
  });
  if ((result?.rowCount ?? 0) === 0) {
    throw new ExternalMcpServerWriteConflictError();
  }
  invalidateCache();
}

/**
 * Guarded DELETE (Refs cinatra#658). Deletes by id only if the row STILL matches
 * the witnessed `expected` scope+owner. A row that changed scope/owner or
 * vanished since the authz read fails closed (a delete that no longer matches
 * the authorized precondition is refused, not silently treated as success).
 * When `expected.nangoConnectionId` is provided, the row's CURRENT connection
 * must ALSO still match (NULL-safe) — so a concurrent re-key that moved the
 * connection fails the delete closed rather than removing a row (and orphaning
 * the new credential) under a stale view (cinatra#1407). Throws
 * `ExternalMcpServerWriteConflictError` on a zero-row match.
 */
export function deleteExternalMcpServerGuarded(
  id: string,
  expected: ExternalMcpServerGuard,
): void {
  ensurePostgresSchema();
  const witnessNango = expected.nangoConnectionId !== undefined;
  const values: unknown[] = [id, expected.scope, expected.userId];
  if (witnessNango) values.push(expected.nangoConnectionId ?? null);
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `DELETE FROM "${q(postgresSchema)}"."external_mcp_servers"
               WHERE id = $1
                 AND scope = $2
                 AND user_id IS NOT DISTINCT FROM $3${
                   witnessNango ? "\n                 AND nango_connection_id IS NOT DISTINCT FROM $4" : ""
                 }
               RETURNING id`,
        values,
      },
    ],
  });
  if ((result?.rowCount ?? 0) === 0) {
    throw new ExternalMcpServerWriteConflictError();
  }
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
        approval: "auto_execute",
        // Transport persisted on the row (llm-providers S2, #1713); legacy rows
        // classify as "unknown". Never inferred from serverUrl.
        transport: row.transport,
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
      approval: "auto_execute",
      // Transport persisted on the row (llm-providers S2, #1713); legacy rows
      // classify as "unknown". Never inferred from serverUrl.
      transport: row.transport,
    };
  } catch (err) {
    console.warn(
      "[external-mcp-registry] buildSingleExternalMcpTool failed — returning null",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Twenty CRM connect flow (issue cinatra-ai/twenty-connector#39).
//
// Productionizes the dev-auto-setup Twenty attach as a UI-triggered flow: an
// admin pastes a Twenty instance URL + API key on the connector setup page, and
// this code (a) guards + normalizes the URL, (b) LIVE-PROBES the key against the
// instance BEFORE persisting (fail-closed), (c) imports the key into Nango under
// the SHARED external-MCP provider key (EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY),
// readback-verified, then (d) upserts the singleton twenty-workspace row binding
// the connection + the Layer-B read allowlist. resolveExternalMcpServerBearer is
// UNCHANGED (no resolver change, no seal-store change).
//
// It lives HERE (rather than a dedicated module) so the connect flow adds NO new
// module to the locked route graphs that reach the external-MCP registry (the
// dev-perf route-graph ratchet); all of its dependencies (the row CRUD above,
// nango-system, node:crypto) are already in this module's graph — the same
// reason createExternalMcpServerAction does its work through this module.
//
// SECURITY (codex-converged, issue #39):
//   - The pasted key is NEVER logged (errors carry a generic message only).
//   - The key transits this SERVER action in-process only; it is stored sealed
//     at rest by Nango. cinatra keeps no plaintext copy (the row has no key
//     column — only the connection id).
//   - ALL authority is derived from the trusted session by the caller (the
//     "use server" action) — this code takes only the instance URL + key. It
//     NEVER accepts a caller-supplied Nango connection id / provider key / row
//     id / scope (a client-supplied pointer is a credential-routing hazard).
//   - Instance-global admin-managed singleton for the MVP; per-user connections
//     are deferred (they need a per-user row id + an actor-aware getTwentyRow).
// ---------------------------------------------------------------------------

/** The singleton external_mcp_servers row id the Twenty CRM transport resolves
 *  by id. Instance-global / admin-managed for the MVP. */
export const TWENTY_WORKSPACE_ROW_ID = "twenty-workspace";
/** Default human label for the Twenty workspace row. */
export const TWENTY_ROW_LABEL = "Twenty CRM";
/** The Nango integration template the shared external-MCP provider uses for a
 *  bearer API key (matches the dev-auto-setup import). */
const TWENTY_NANGO_INTEGRATION_PROVIDER = "private-api-bearer";
/**
 * Layer-B catalog allowlist — the read tools the Twenty MCP proxy permits on
 * every execute_tool. READ-ONLY at first; write verbs land with the
 * agent-rewrite cutover. Native MCP tools are controlled by Layer A allowedTools,
 * NOT Layer B — never include them here. Shared with dev-auto-setup.
 */
export const TWENTY_LAYER_B_CATALOG_TOOLS: readonly string[] = [
  "find_companies",
  "find_people",
  "find_one_company",
  "find_one_person",
  "get_views",
] as const;

/** A user-actionable Twenty connect failure. The message is safe to surface
 *  (never carries the key or a readback value). */
export class TwentyConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwentyConnectionError";
  }
}

/** Current Twenty connection state for the setup page (never returns the key). */
export type TwentyConnectionState = {
  connected: boolean;
  instanceUrl: string | null;
};

/**
 * True for a hostname that is loopback, RFC-1918 private, or link-local (incl.
 * the 169.254.169.254 cloud-metadata address). The probe + the LLM-facing proxy
 * both make server-side requests to serverUrl, so a private target is an SSRF
 * hazard. NOTE: checks the literal host only; a public DNS name that resolves to
 * a private address (DNS rebinding) is NOT caught here — that residual is shared
 * with the existing external-MCP proxy surface and is tracked as follow-up.
 */
function isPrivateOrLinkLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    h === "0.0.0.0" ||
    /^f[cd][0-9a-f]{2}:/.test(h) ||
    /^fe80:/.test(h)
  );
}

/**
 * Validate + normalize a Twenty instance URL and derive the REST base (for the
 * live probe) + the MCP endpoint (persisted as the row's serverUrl). Throws a
 * TwentyConnectionError on a bad URL. Guard: http only for localhost; https +
 * public otherwise (private/link-local/metadata rejected). A trailing slash and
 * any pasted /mcp suffix are normalized away.
 */
export function normalizeTwentyInstanceUrl(raw: string): { restBase: string; mcpUrl: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new TwentyConnectionError("Enter your Twenty instance URL.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TwentyConnectionError("Enter a valid instance URL, including https://.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TwentyConnectionError("The instance URL must start with http:// or https://.");
  }
  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !isLocalhost) {
    throw new TwentyConnectionError("The instance URL must use HTTPS.");
  }
  if (!isLocalhost && isPrivateOrLinkLocalHost(url.hostname)) {
    throw new TwentyConnectionError(
      "The instance URL must be a public address (private or link-local addresses are not allowed).",
    );
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/i, "");
  const restBase = `${url.origin}${path}`;
  return { restBase, mcpUrl: `${restBase}/mcp` };
}

/**
 * The Nango connection id for a given instance. DERIVED FROM THE INSTANCE URL so
 * changing the URL yields a DIFFERENT connection id: a re-save under a new URL
 * never overwrites the previous URL's key, and if the row upsert fails the row
 * keeps pointing at its old {serverUrl, connection} pair (no key↔URL mismatch).
 */
function twentyConnectionIdFor(restBase: string): string {
  const digest = createHash("sha256").update(restBase).digest("hex").slice(0, 16);
  return `${TWENTY_WORKSPACE_ROW_ID}-${digest}`;
}

/**
 * Live-probe a Twenty API key against the instance's REST surface. Returns
 * "ok" | "unauthorized" | "unreachable". Never logs the key.
 */
async function probeTwentyKey(
  restBase: string,
  apiKey: string,
  timeoutMs = 8000,
): Promise<"ok" | "unauthorized" | "unreachable"> {
  const url = `${restBase.replace(/\/+$/, "")}/rest/companies?limit=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "unauthorized";
    return "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/** Read the current Twenty connection state from the singleton row. */
export function getTwentyConnectionState(): TwentyConnectionState {
  const row = getExternalMcpServerById(TWENTY_WORKSPACE_ROW_ID);
  if (!row) return { connected: false, instanceUrl: null };
  const instanceUrl = row.serverUrl.replace(/\/mcp$/i, "");
  return { connected: row.enabled && Boolean(row.nangoConnectionId), instanceUrl };
}

/**
 * Connect (or re-connect) the instance-global Twenty workspace. Guards the URL,
 * live-probes the key, imports it into Nango under the shared external-MCP
 * provider (readback-verified), then upserts the singleton row. The caller MUST
 * have already authorized the actor as an admin/org-manager — this takes no
 * caller-supplied connection/scope pointer.
 */
export async function saveTwentyConnection(input: {
  instanceUrl: string;
  apiKey: string;
  /** The connecting admin (cinatra#952 W2): owns the connection's identity
   * row. Threaded from the acting session by the server action. */
  owner?: { userId: string; organizationId: string | null };
}): Promise<void> {
  const apiKey = (input.apiKey ?? "").trim();
  if (!apiKey) throw new TwentyConnectionError("Enter your Twenty API key.");
  const { restBase, mcpUrl } = normalizeTwentyInstanceUrl(input.instanceUrl);

  if (!isNangoConfigured()) {
    throw new TwentyConnectionError(
      "The connection service (Nango) is not configured — an administrator must run `cinatra setup nango` first.",
    );
  }

  // (1) MANDATORY live probe BEFORE any persistence (fail-closed).
  const probe = await probeTwentyKey(restBase, apiKey);
  if (probe === "unauthorized") {
    throw new TwentyConnectionError(
      "Twenty rejected that API key (401/403). Check the key and try again.",
    );
  }
  if (probe !== "ok") {
    throw new TwentyConnectionError(
      "Could not reach the Twenty instance to verify the key — check the instance URL and that Twenty is reachable.",
    );
  }

  // (2) Import the key into Nango under the SHARED external-MCP provider key
  //     (the resolver reads exactly this pair). No connectorKey => no pointer
  //     record; the resolver reads the raw connection. The connection id is
  //     DERIVED FROM THE URL so a URL change never reuses the prior URL's key.
  const connectionId = twentyConnectionIdFor(restBase);
  // PRE-write foreign-identity guard (codex diff-round-3 finding 1): when the
  // URL-derived connection id already has a LIVE identity owned by a
  // different user/org, refuse BEFORE the vault import / row upsert mutate
  // anything (the same fail-closed boundary the generic save route enforces).
  if (input.owner) {
    try {
      const { readNangoConnectionByNaturalKey } = await import(
        "@cinatra-ai/extensions/connection-identity-store"
      );
      const existing = await readNangoConnectionByNaturalKey("externalMcp", connectionId);
      if (
        existing &&
        (existing.ownerUserId !== input.owner.userId ||
          (existing.organizationId != null &&
            input.owner.organizationId != null &&
            existing.organizationId !== input.owner.organizationId))
      ) {
        throw new TwentyConnectionError(
          "This Twenty instance is already connected under a different owner or workspace — disconnect it there first.",
        );
      }
    } catch (err) {
      if (err instanceof TwentyConnectionError) throw err;
      // Identity store unavailable (degraded/unit contexts): the post-import
      // seam still hard-fails a foreign row before any grant is seeded.
    }
  }
  const priorConnectionId =
    getExternalMcpServerByIdFresh(TWENTY_WORKSPACE_ROW_ID)?.nangoConnectionId ?? null;
  await ensureNangoIntegration({
    provider: TWENTY_NANGO_INTEGRATION_PROVIDER,
    providerConfigKey: EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
    displayName: "Cinatra External MCP",
  });
  await importNangoConnection({
    providerConfigKey: EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
    connectionId,
    credentials: { type: "API_KEY", apiKey },
  });

  // (3) Readback-verify the write landed (generic message only — never the value).
  const readback = await getNangoCredentials(EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY, connectionId, {
    forceRefresh: true,
  });
  const readbackKey =
    readback && typeof readback === "object" && "apiKey" in readback
      ? (readback as { apiKey?: unknown }).apiKey
      : null;
  if (readbackKey !== apiKey) {
    throw new TwentyConnectionError(
      "The connection service did not store the key correctly (readback mismatch). Please try again.",
    );
  }

  // (4) Single row upsert: singleton id, workspace scope, Layer-B read allowlist.
  upsertExternalMcpServer({
    id: TWENTY_WORKSPACE_ROW_ID,
    label: TWENTY_ROW_LABEL,
    serverUrl: mcpUrl,
    nangoConnectionId: connectionId,
    scope: "workspace",
    orgId: null,
    userId: null,
    enabled: true,
    allowedTools: null,
    allowedCatalogTools: [...TWENTY_LAYER_B_CATALOG_TOOLS],
  });

  // (5) Identity-seam insert (cinatra#952 W2): the external-MCP connection
  // gets its identity row (connector_key "externalMcp", owner = the
  // connecting admin) + the owner-scoped grant seed. Without an owner
  // (legacy programmatic path) the row is left for the core__0015 seed.
  if (input.owner) {
    const { registerSavedConnectionIdentity } = await import(
      "@/lib/connection-identity-seam"
    );
    await registerSavedConnectionIdentity({
      connectorKey: "externalMcp",
      connectionId,
      ownerUserId: input.owner.userId,
      organizationId: input.owner.organizationId,
      // The Twenty workspace row is admin-created instance-global by
      // construction — behavior-preserving workspace seed (an owner-only
      // grant would deny the org-bound InternalWorker mint).
      seed: "workspace",
    });
  }

  // (6) After a URL change, best-effort remove the PREVIOUS instance's Nango
  // key — identity row FIRST (revocation-next-use), then the upstream token.
  if (priorConnectionId && priorConnectionId !== connectionId) {
    // Identity row FIRST (revocation-next-use), each step independently best-effort so a
    // degraded identity store never blocks the upstream token removal.
    try {
      const { readNangoConnectionByNaturalKey, softDeleteNangoConnection } = await import(
        "@cinatra-ai/extensions/connection-identity-store"
      );
      const prior = await readNangoConnectionByNaturalKey("externalMcp", priorConnectionId);
      if (prior) await softDeleteNangoConnection(prior.id);
    } catch {
      // Best-effort: identity store unavailable — the token delete still runs.
    }
    try {
      await deleteNangoConnection(EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY, priorConnectionId);
    } catch {
      // Best-effort: the row no longer references the prior connection.
    }
  }
}

// DEV-ONLY seeded-actor holder (cinatra#1238). The dev-boot shell
// (`dev-auto-setup.ts`) resolves the deterministic dev user+org and PUSHES it
// here via `setDevActorForExternalMcp` BEFORE invoking any connector devSetup
// hook. `devAttachTwentyBearerFromMintedKey` reads it instead of importing the
// wide dev-auto-setup module graph — that edge would grow the production
// route-graph of every route reachable through this broadly-imported registry.
// Null off dev boot; the writer fails closed when unset.
let seededDevActorForExternalMcp: { userId: string; organizationId: string } | null = null;

/** DEV-ONLY: the dev-boot shell pushes (or clears) the seeded dev-actor owner. */
export function setDevActorForExternalMcp(
  actor: { userId: string; organizationId: string } | null,
): void {
  seededDevActorForExternalMcp = actor;
}

/**
 * DEV-ONLY (cinatra#1238): attach a freshly dev-minted Twenty workspace API key
 * through the SAME sanctioned path the setup-page connect flow uses
 * (`saveTwentyConnection`), then VERIFY the gated bearer resolver actually mints
 * it. This closes the demo-boot credential gap: the twenty-connector's dev-mint
 * used to import the raw Nango credential directly, which leaves
 * `resolveExternalMcpServerBearer` failing CLOSED because
 * `gateExternalMcpConnectionUse` requires an `externalMcp` connection-identity
 * row + workspace grant that ONLY the sanctioned save seeds (a raw
 * `getNangoCredentials` readback passes — a false positive — while the gated
 * resolver returns null → the agent 401s). `saveTwentyConnection` runs the live
 * key probe, the foreign-identity preflight, the Nango import + readback, the
 * `twenty-workspace` row upsert, the identity + `seed:"workspace"` grant, and
 * the prior-key cleanup — all bound to the seeded dev actor.
 *
 * The seeded dev actor's organization MUST be non-null: `seed:"workspace"`
 * downgrades to owner-only under a null org (the InternalWorker mint would stay
 * denied), so this fails CLOSED (`resolved:false`) when no dev actor / org
 * resolves. Never throws. SECRET BOUNDARY: the key is never logged or returned;
 * any thrown message (a generic `TwentyConnectionError`) is swallowed to a
 * boolean result.
 */
export async function devAttachTwentyBearerFromMintedKey(input: {
  instanceUrl: string;
  apiKey: string;
}): Promise<{ resolved: boolean; connectionId: string | null }> {
  try {
    // The seeded dev-actor owner is PUSHED here by the dev-boot shell
    // (`dev-auto-setup.ts` -> `setDevActorForExternalMcp`, seeded BEFORE any
    // connector devSetup hook runs). Reading it from a module-local holder —
    // rather than importing the dev-auto-setup module — keeps that wide dev-boot
    // graph OUT of the production route-graph pressure (this registry is broadly
    // reachable from /api/mcp, /chat, etc.; the edge would grow every route).
    const actor = seededDevActorForExternalMcp;
    if (!actor?.userId || !actor?.organizationId) {
      return { resolved: false, connectionId: null };
    }
    await saveTwentyConnection({
      instanceUrl: input.instanceUrl,
      apiKey: input.apiKey,
      owner: { userId: actor.userId, organizationId: actor.organizationId },
    });
    // Verify the GATED resolver — not just the raw Nango readback — now mints a
    // bearer, so the returned `resolved` is honest end-to-end (the row is upserted
    // inside saveTwentyConnection, so it exists here on the first boot).
    const row = getExternalMcpServerByIdFresh(TWENTY_WORKSPACE_ROW_ID);
    if (!row) return { resolved: false, connectionId: null };
    const bearer = await resolveExternalMcpServerBearer(row);
    return { resolved: bearer != null, connectionId: row.nangoConnectionId };
  } catch {
    return { resolved: false, connectionId: null };
  }
}

/**
 * Disconnect the Twenty workspace: remove the row, then best-effort delete the
 * Nango connection. The row is read FRESH (bypassing the TTL cache) so a stale
 * null cache on another worker cannot leave the Nango key behind.
 */
export async function disconnectTwentyConnection(): Promise<void> {
  const row = getExternalMcpServerByIdFresh(TWENTY_WORKSPACE_ROW_ID);
  // Revocation ordering (codex diff-round-3 finding 2): soft-delete the
  // IDENTITY row before the registry row — cross-worker row caches can keep
  // serving the row for up to the cache TTL, and the identity soft-delete is
  // what makes the use-gate deny those stale mints immediately.
  if (row?.nangoConnectionId) {
    try {
      const { readNangoConnectionByNaturalKey, softDeleteNangoConnection } = await import(
        "@cinatra-ai/extensions/connection-identity-store"
      );
      const identity = await readNangoConnectionByNaturalKey(
        "externalMcp",
        row.nangoConnectionId,
      );
      if (identity) await softDeleteNangoConnection(identity.id);
    } catch {
      // Best-effort: identity store unavailable — the row + token deletes below still run.
    }
  }
  deleteExternalMcpServer(TWENTY_WORKSPACE_ROW_ID);
  if (row?.nangoConnectionId && isNangoConfigured()) {
    // The identity row was soft-deleted above (before the row delete); the
    // upstream token delete stays best-effort. External-MCP rows have no blob
    // pointer record to remove.
    try {
      await deleteNangoConnection(EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY, row.nangoConnectionId);
    } catch {
      // Best-effort: the row (the resolver binding) is already deleted.
    }
  }
}
