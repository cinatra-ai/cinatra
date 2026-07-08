// ---------------------------------------------------------------------------
// Dedicated `/api/cli` OAuth resource — audiences + scopes for the CLI
// control-plane (the CLI-audience decision record §2d "D2-A").
//
// WHY a SEPARATE resource from `/api/mcp`:
//   The MCP tool surface (`/api/mcp`) is verified by `verifyMcpAccessToken`
//   against `aud=<origin>/api/mcp`. If the CLI REST control-plane reused that
//   verifier, ANY `mcp:connect` MCP token would also authorize `/api/cli` —
//   the audience-confusion hole. So the CLI gets its OWN RFC 8707 resource
//   (`<origin>/api/cli`) and its OWN scopes, and an MCP-only token (bound to
//   `aud=<origin>/api/mcp`) is REJECTED at `/api/cli` by exact-audience
//   verification (plus a post-verify `aud` allowlist that rejects any token
//   also carrying the `/api/mcp` resource audience).
//
// This module is intentionally dependency-light (no React, no `@/` aliases,
// no DB): it exports the constants + a pure audience builder that BOTH the
// auth-plugin wiring (issuance: register `/api/cli` as a valid audience) and
// the app-side verifier (verification: accept `aud=<origin>/api/cli`) consume,
// so issuance and verification can never drift.
// ---------------------------------------------------------------------------

/** The CLI REST control-plane base path (the RFC 8707 resource path). */
export const CLI_RESOURCE_BASE_PATH = "/api/cli";

/** The MCP tool-surface base path — used ONLY to reject cross-surface tokens. */
export const MCP_RESOURCE_BASE_PATH = "/api/mcp";

/**
 * CLI-specific OAuth scopes. These are ADVERTISED + ALLOWED for dynamic-client
 * registration so a public PKCE CLI client can REQUEST them, but they MUST be
 * EXCLUDED from the DCR DEFAULT scopes — a freshly-registered client must not
 * silently receive control-plane authority. "Scope admits, role authorizes":
 * the scope is only an admission ticket; the server still resolves the real
 * platform/org role and gates per-route.
 */
export const CLI_OAUTH_SCOPES = [
  "cli:status",
  "cli:agent:read",
  "cli:agent:write",
] as const;

export type CliOAuthScope = (typeof CLI_OAUTH_SCOPES)[number];

/** True when `scope` is one of the dedicated CLI scopes. */
export function isCliOAuthScope(scope: string): scope is CliOAuthScope {
  return (CLI_OAUTH_SCOPES as readonly string[]).includes(scope);
}

/**
 * Join an origin and a path into a canonical audience/resource URL. Mirrors the
 * private `combineOriginAndPath` in index.tsx EXACTLY (`${origin}${path}`, with
 * a bare "/" collapsing to the origin) so a CLI audience built here is
 * byte-identical to one the transport/issuance path would build. Origins come
 * from `getTrustedTokenOrigins()`, which already trims trailing slashes.
 */
export function combineOriginAndPath(origin: string, path: string): string {
  return `${origin}${path === "/" ? "" : path}`;
}

/** The `/api/cli` resource audience for a given origin (`<origin>/api/cli`). */
export function cliAudienceForOrigin(origin: string): string {
  return combineOriginAndPath(origin, CLI_RESOURCE_BASE_PATH);
}

/** The `/api/mcp` resource audience for a given origin (`<origin>/api/mcp`). */
export function mcpAudienceForOrigin(origin: string): string {
  return combineOriginAndPath(origin, MCP_RESOURCE_BASE_PATH);
}

/**
 * Build the list of `/api/cli` audiences to register as valid at ISSUANCE,
 * given the same trusted origins the MCP plugins already use. Registering
 * these in `validAudiences` lets `oauth-provider` mint a JWT bound to
 * `aud=<origin>/api/cli` when the CLI requests `resource=<origin>/api/cli`
 * (without an entry, the provider would fall back to an OPAQUE token that the
 * JWKS verifier rejects).
 */
export function cliValidAudiences(origins: readonly string[]): string[] {
  return origins.map((o) => cliAudienceForOrigin(o));
}

/**
 * Post-verify audience guard (codex MAJOR): even after `verifyAccessToken`
 * accepts `aud=<origin>/api/cli`, a deliberately multi-audience token could
 * ALSO carry `aud=<origin>/api/mcp`. JOSE accepts an audience ARRAY when ANY
 * entry matches, so the exact-audience check alone does not reject such a
 * token. This guard FAILS CLOSED on any token whose audience set contains a
 * `/api/mcp` resource audience for ANY trusted origin — a CLI token must be
 * bound to the CLI resource and never double as an MCP token.
 *
 * Returns true when the audience claim is acceptable (CLI-bound, no MCP
 * audience), false when it must be rejected.
 */
export function cliAudienceClaimIsAcceptable(
  audClaim: unknown,
  origins: readonly string[],
): boolean {
  const auds: string[] =
    typeof audClaim === "string"
      ? [audClaim]
      : Array.isArray(audClaim)
        ? audClaim.filter((a): a is string => typeof a === "string")
        : [];
  if (auds.length === 0) return false;

  const cliAuds = new Set(origins.map((o) => cliAudienceForOrigin(o)));
  const mcpAuds = new Set(origins.map((o) => mcpAudienceForOrigin(o)));

  // Must be bound to at least one CLI audience…
  const hasCli = auds.some((a) => cliAuds.has(a));
  if (!hasCli) return false;
  // …and must NOT carry any MCP resource audience (cross-surface token).
  const hasMcp = auds.some((a) => mcpAuds.has(a));
  if (hasMcp) return false;

  return true;
}
