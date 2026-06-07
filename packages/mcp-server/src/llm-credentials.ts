/**
 * LLM MCP access credentials — owned by @cinatra-ai/mcp-server.
 *
 * In development, `cinatra mcp llm-access setup` provisions OAuth clients for
 * each LLM provider (OpenAI, Anthropic, Gemini) so they can access the Cinatra
 * MCP server with restricted permissions. This module reads those credentials
 * from the database so the orchestration layer (and other consumers) can use
 * them to connect LLM providers to the MCP server.
 *
 * The credentials are intentionally stored here (not in llm)
 * because they are OAuth client records owned by the MCP server.
 */

import "server-only";

import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";
// Pure URL-shape rules live in a dependency-free .mjs
// module the CLI can also import (the CLI has no Next path aliases and no
// `server-only` runtime, so it cannot import this TS file directly).
import { buildMcpPublicBaseUrlRow } from "./mcp-public-base-url-shape.mjs";

const LLM_MCP_SETTINGS_KEY = "llm_mcp_access";
const MCP_SERVER_SETTINGS_KEY = "mcp_server";

type LlmMcpProviderCredentials = {
  clientId: string;
  clientSecret: string;
  clientName: string;
  scope: string;
  blockedToolPatterns: string[];
};

type LlmMcpAccessSettings = {
  providers?: Record<string, LlmMcpProviderCredentials>;
  updatedAt?: string;
};

type McpServerSettings = {
  publicBaseUrl?: string | null;
  publicBaseUrlSource?: string;
  [key: string]: unknown;
};

/**
 * Return the local OAuth token endpoint URL.
 * Used to exchange client_credentials for a Bearer token on the server side.
 * Always resolves against the local origin (BETTER_AUTH_URL or localhost:3000)
 * so the token issuer matches what verifyMcpAccessToken expects.
 */
export function getLocalTokenEndpointUrl(authBasePath: string): string {
  const localOrigin =
    (process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000")
      .replace(/\/+$/, "");
  return `${localOrigin}${authBasePath}/oauth2/token`;
}

/**
 * Return the local canonical MCP server URL.
 * Used as the `resource` parameter in client_credentials token requests (RFC 8707)
 * so Better Auth issues a JWT (aud = this URL) instead of an opaque token.
 * Must match validAudiences in oauthProvider config and the audience checked by
 * verifyMcpAccessToken.
 */
export function getLocalMcpServerUrl(mcpBasePath: string): string {
  const localOrigin =
    (process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000")
      .replace(/\/+$/, "");
  return `${localOrigin}${mcpBasePath}`;
}

/**
 * Read the current public base URL plus its source.
 *
 * Every source EXCEPT `"cli"` is honored. `"cli"` was written by the retired
 * cloudflared quick-tunnel manager — that process no longer runs, so a `"cli"`
 * URL is always dead and must be ignored. Every other source (`"manual"` from
 * the dev tab, plus legacy `"external"` / `"tailscale-funnel"` / similar rows
 * from operator-managed tunnels) is a real operator-supplied URL that still
 * works — those are honored and reported as `"manual"`. `"tailscale-auto"`
 * is used for URLs written by `cinatra clone start` via the Nango-stored
 * OAuth client; the stored source is preserved on read.
 * Empty, invalid, or `"cli"` → `{ publicBaseUrl: null,
 * publicBaseUrlSource: "unknown" }`.
 */
export type McpPublicBaseUrlSource = "manual" | "tailscale-auto" | "tailscale-funnel" | "unknown";

/**
 * True for errors that mean "the DB is unreachable at boot" (vs a real
 * reachable-DB error like a permission/query/schema failure, which must stay
 * fail-loud). Used to keep the module-eval boot read in getMcpPublicBaseUrl()
 * from crashing the Next.js instrumentation hook when there is no live DB.
 */
function isBootDbUnavailableError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  // NOTE: match only unambiguous DB-unavailable signals. Do NOT use a bare
  // `connect` token — it substring-matches the `connector_config` table name, so
  // a reachable-DB permission/schema/query error (e.g. `relation
  // "connector_config" does not exist`) would be wrongly swallowed. The errno
  // strings + full connection-failure phrases below cannot appear in such errors.
  return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Timed out while executing Postgres|terminating connection|Connection terminated|the database system is starting up|could not connect to server|Connection refused|SUPABASE_DB_URL|DATABASE_URL/i.test(
    msg,
  );
}

export function getMcpPublicBaseUrl(): { publicBaseUrl: string | null; publicBaseUrlSource: McpPublicBaseUrlSource } {
  // This is read SYNCHRONOUSLY (postgres-sync, which throws on a connect
  // failure) at MODULE EVAL: `src/lib/auth.ts` calls createMcpServerAuthPlugins()
  // + getDynamicTrustedOrigins() at the top level, and auth.ts is pulled into the
  // Next.js instrumentation hook at boot. An unreachable DB here ("connect
  // ECONNREFUSED …") would crash the hook ("An error occurred while loading
  // instrumentation hook" → webServer exit 1) on any boot without a live DB —
  // a fresh install pre-setup, or the design-visual-verify e2e (placeholder DB).
  // Fall back to "no public URL" when the DB is unavailable; it is re-read at
  // runtime via the normal request path.
  let raw: Record<string, unknown>;
  try {
    raw = readConnectorConfigFromDatabase<McpServerSettings>(MCP_SERVER_SETTINGS_KEY, {}) as Record<string, unknown>;
  } catch (err) {
    if (isBootDbUnavailableError(err)) {
      return { publicBaseUrl: null, publicBaseUrlSource: "unknown" };
    }
    // A reachable-DB error (permission / query / schema failure) is a real bug —
    // fail loud rather than silently disabling the public MCP URL.
    throw err;
  }
  // "cli" = the retired cloudflared quick tunnel; that process is gone, the URL is dead.
  if (raw?.publicBaseUrlSource === "cli") {
    return { publicBaseUrl: null, publicBaseUrlSource: "unknown" };
  }
  const value = typeof raw?.publicBaseUrl === "string" ? raw.publicBaseUrl.trim() : "";
  if (!value) return { publicBaseUrl: null, publicBaseUrlSource: "unknown" };
  // Re-normalize to origin-only on read. `setMcpPublicBaseUrl` rejects paths,
  // but a legacy row written before that guard could still carry one — and
  // `getPublicMcpServerUrl()` appends /api/mcp, so a stored path would double.
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { publicBaseUrl: null, publicBaseUrlSource: "unknown" };
    }
    // Preserve `publicBaseUrlSource` from the row instead of
    // force-normalizing every read to `"manual"`. The CLI writes
    // `"tailscale-auto"` when it auto-provisions via the Nango OAuth client;
    // the dev tab needs to distinguish that from operator-pasted URLs.
    const storedSource = typeof raw?.publicBaseUrlSource === "string" ? raw.publicBaseUrlSource : "";
    const source: McpPublicBaseUrlSource =
      storedSource === "tailscale-auto" || storedSource === "tailscale-funnel"
        ? storedSource
        : "manual";
    return { publicBaseUrl: `${parsed.protocol}//${parsed.host}`, publicBaseUrlSource: source };
  } catch {
    return { publicBaseUrl: null, publicBaseUrlSource: "unknown" };
  }
}

/**
 * Persist a new manually-configured public base URL. Pass `null` (or an empty
 * string) to clear it. Trims and strips trailing slashes to match the shape
 * read by `getMcpPublicBaseUrl`.
 *
 * Throws when the URL is non-empty but not a valid http(s):// URL.
 */
export function setMcpPublicBaseUrl(url: string | null | undefined): void {
  const current = readConnectorConfigFromDatabase<McpServerSettings>(MCP_SERVER_SETTINGS_KEY, {}) as Record<string, unknown>;
  // Validation + URL-shape lives in `mcp-public-base-url-shape.mjs`
  // so the Cinatra CLI can run the same rules when writing into a clone DB.
  // `buildMcpPublicBaseUrlRow` throws on invalid input (preserving the
  // pre-refactor error wording for the path / scheme / query / fragment cases).
  const next = buildMcpPublicBaseUrlRow(current, url);
  writeConnectorConfigToDatabase(MCP_SERVER_SETTINGS_KEY, next);
}


/**
 * Returns the set of origins (e.g. "https://app.example.com") whose
 * client_credentials tokens this MCP server should accept.
 *
 * Includes:
 *   1. The local origin (BETTER_AUTH_URL or http://localhost:3000) — always.
 *   2. The configured manual publicBaseUrl from the DB, when set.
 *
 * Used by verifyMcpAccessToken to support multi-origin tokens (a token issued
 * via a stable public URL must verify when used via that public URL, even
 * though the verifier's local origin is http://localhost:3000).
 */
export function getTrustedTokenOrigins(): string[] {
  const localOrigin =
    (process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000")
      .trim()
      .replace(/\/+$/, "");
  const out = new Set<string>([localOrigin]);
  const { publicBaseUrl } = getMcpPublicBaseUrl();
  if (publicBaseUrl) out.add(publicBaseUrl);
  return Array.from(out);
}

/**
 * Hostnames for better-auth `trustedOrigins`. Derived from getTrustedTokenOrigins
 * (so the same set of trusted public URLs governs both OAuth CSRF protection
 * and MCP token verification). Plus any origins added via the legacy env var
 * BETTER_AUTH_TRUSTED_ORIGINS (comma-separated) for CI / containerized dev.
 */
export function getTrustedOriginHostnames(): string[] {
  const out = new Set<string>();
  for (const origin of getTrustedTokenOrigins()) {
    try { out.add(new URL(origin).hostname); }
    catch { /* skip malformed */ }
  }
  const legacy = process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  for (const entry of legacy) out.add(entry);
  return Array.from(out);
}

/**
 * Read the public MCP server URL.
 * This is the URL that LLM providers use to connect to /api/mcp.
 * Returns null if no public URL is configured.
 */
export function getPublicMcpServerUrl(): string | null {
  const { publicBaseUrl } = getMcpPublicBaseUrl();
  if (!publicBaseUrl) return null;
  return `${publicBaseUrl}/api/mcp`;
}

/**
 * Read the MCP access credentials for a specific LLM provider.
 * Returns null if no credentials are provisioned (e.g. production mode).
 */
export function getLlmMcpCredentials(provider: string): LlmMcpProviderCredentials | null {
  const settings = readConnectorConfigFromDatabase<LlmMcpAccessSettings>(LLM_MCP_SETTINGS_KEY, {});
  const providerConfig = settings?.providers?.[provider];
  if (!providerConfig?.clientId || !providerConfig?.clientSecret) {
    return null;
  }
  return providerConfig;
}

/**
 * Check if LLM MCP access is fully configured (credentials + public URL).
 */
export function hasLlmMcpAccess(): boolean {
  const settings = readConnectorConfigFromDatabase<LlmMcpAccessSettings>(LLM_MCP_SETTINGS_KEY, {});
  const hasCredentials = Boolean(settings?.providers && Object.keys(settings.providers).length > 0);
  const hasPublicUrl = Boolean(getPublicMcpServerUrl());
  return hasCredentials && hasPublicUrl;
}

/**
 * Get the full LLM MCP access status for diagnostics.
 */
export function getLlmMcpAccessStatus(): {
  publicUrl: string | null;
  providers: Record<string, { configured: boolean }>;
} {
  const publicUrl = getPublicMcpServerUrl();
  const settings = readConnectorConfigFromDatabase<LlmMcpAccessSettings>(LLM_MCP_SETTINGS_KEY, {});

  const providers: Record<string, { configured: boolean }> = {};
  for (const id of ["openai", "anthropic", "gemini"]) {
    const creds = settings?.providers?.[id];
    providers[id] = { configured: Boolean(creds?.clientId && creds?.clientSecret) };
  }

  return { publicUrl, providers };
}

export const LLM_BLOCKED_TOOL_PATTERNS = [
  "permissions_",  // org admin operations — role changes, member removal
  "_system_",      // system-level internals
  "_jobs_",        // background job runners
  "process_due",   // scheduled follow-up processors
  "apollo_jobs_",  // Apollo background jobs
];

/**
 * Write or clear LLM MCP credentials for a single provider.
 * Pass null to remove the provider entry.
 */
export function writeLlmMcpCredentials(
  provider: string,
  creds: { clientId: string; clientSecret: string; clientName: string; scope: string; blockedToolPatterns: string[] } | null,
) {
  const existing = readConnectorConfigFromDatabase<LlmMcpAccessSettings>(LLM_MCP_SETTINGS_KEY, {});
  const providers = { ...(existing?.providers ?? {}) };
  if (creds === null) {
    delete providers[provider];
  } else {
    providers[provider] = { ...creds };
  }
  writeConnectorConfigToDatabase(LLM_MCP_SETTINGS_KEY, { providers, updatedAt: new Date().toISOString() });
}
