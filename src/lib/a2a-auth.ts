import "server-only";

import type { Auth } from "better-auth";
import { createHash } from "node:crypto";
import { auth } from "@/lib/auth";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { createAuthClient as createServerAuthClient } from "better-auth/client";
import { betterAuthDb } from "@/lib/better-auth-db";
import { sql } from "drizzle-orm";
import {
  POLICY_VERSION,
  type ActorContext,
  type ScopedA2AServiceAccountContext,
} from "@/lib/authz/actor-context";
import { parseTokenScopes } from "@/lib/authz/scope-map";
import {
  readServiceAccountByClientId,
  type ServiceAccountRecord,
} from "@/lib/service-accounts";

// ---------------------------------------------------------------------------
// A2A Bearer token verification.
//
// Mirrors `verifyMcpAccessToken` in `packages/mcp-server/src/index.tsx`. The
// tunnel audience bug is avoided the same way: we always resolve the canonical
// local origin via `inferLocalAppOrigin()` so a token issued against
// http://localhost:3000 remains valid even when the request arrives via a
// Cloudflare tunnel hostname.
//
// Required scope: "a2a:connect" — registered declaratively in src/lib/auth.ts.
//
// Localhost requests bypass the Bearer check only when `A2A_DEV_BYPASS=true`
// is set — enabling dev-loop smoke testing without seeding a
// client_credentials grant. Production deployments must not set this var;
// any request from a non-local host MUST present a valid Bearer token
// carrying `a2a:connect`.
// ---------------------------------------------------------------------------

const A2A_BASE_PATH = "/api/a2a";
const MCP_BASE_PATH = "/api/mcp";
const AUTH_BASE_PATH = "/api/auth";
// `attempts[]` arrays are audience-only. `verifyAccessToken` checks
// signature/expiry, while scope intersection is enforced separately so
// 401/403 semantics remain correct.

function inferLocalAppOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

function isLocalhostRequest(req: Request): boolean {
  // Never honor the loopback bypass in
  // production, even if A2A_DEV_BYPASS=true is misconfigured. Reject any
  // request carrying an x-forwarded-* chain so a proxy-spoofed Host header
  // cannot unlock the bypass via SSRF / proxy-misconfig.
  if (process.env.NODE_ENV === "production") return false;
  if (req.headers.get("x-forwarded-for")) return false;
  try {
    const url = new URL(req.url);
    const h = url.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "host.docker.internal";
  } catch {
    return false;
  }
}

export type A2AAuthResult =
  | { ok: true; subject: string; actorContext?: ActorContext }
  | { ok: false; response: Response };

export async function verifyA2AAccessToken(req: Request): Promise<A2AAuthResult> {
  if (process.env.A2A_DEV_BYPASS === "true" && isLocalhostRequest(req)) {
    return { ok: true, subject: "dev-bypass" };
  }

  // Strict RFC 6750 Bearer-prefix enforcement. Reject any
  // Authorization header that does not begin with "Bearer " — no
  // permissive fallback that would silently accept "Basic …", "Digest …",
  // or naked tokens (header-confusion hardening).
  const authorizationHeader = req.headers.get("authorization");
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return { ok: false, response: unauthorized(req) };
  }
  const accessToken = authorizationHeader.slice("Bearer ".length).trim();
  if (!accessToken) {
    return { ok: false, response: unauthorized(req) };
  }

  const canonicalOrigin = inferLocalAppOrigin();
  const authClient = createServerAuthClient({
    plugins: [oauthProviderResourceClient(auth as unknown as Auth)],
  });

  // Try A2A token first, then fall back to MCP token for LangGraph server-to-server calls.
  // MCP client_credentials only support mcp:connect scope; until a2a:connect is added to
  // the registered OAuth application, both token types must be accepted here.
  // Scope checks are enforced separately; audience routing is sufficient here.
  const attempts = [
    { audience: `${canonicalOrigin}${A2A_BASE_PATH}` },
    { audience: `${canonicalOrigin}${MCP_BASE_PATH}` },
  ];

  for (const attempt of attempts) {
    try {
      // Split signature/expiry (401) from scope mismatch (403). Do NOT
      // pass `scopes:` here; scope intersection is enforced separately
      // via the `forbidden()` helper below.
      await authClient.verifyAccessToken(accessToken, {
        verifyOptions: {
          audience: attempt.audience,
          issuer: `${canonicalOrigin}${AUTH_BASE_PATH}`,
        },
        jwksUrl: `${canonicalOrigin}${AUTH_BASE_PATH}/jwks`,
      });

      // Signature/expiry verified — now build the ActorContext from the
      // JWT payload + service-account row (revocation gate inline).
      const payload = extractA2AJwtPayload(accessToken);
      // Better Auth's oauth-provider sets `azp = clientId` and
      // leaves `sub` undefined for client_credentials grants. Match the
      // resolution precedence used in `mcp-server/src/index.tsx:518-537`:
      // client_id (introspection) > azp (signed JWT) > sub (legacy).
      const clientId =
        payload?.client_id ?? payload?.azp ?? payload?.sub;
      if (!clientId) {
        return { ok: false, response: unauthorized(req) };
      }

      // Lookup by clientId (the JWT's identity claim), NOT by
      // service_accounts.id. The two UUIDs are independently assigned at
      // creation. readServiceAccountByClientId also honors the rotation
      // grace-period window via previous_client_id.
      const account = await readServiceAccountByClientId(clientId);
      if (!account || account.revokedAt !== null) {
        return { ok: false, response: unauthorized(req) };
      }

      const actorContext = buildActorContextFromServiceAccountJwt(
        payload ?? {},
        account,
      );
      // Stable principalId from row PK; clientId rotates, audit logs need
      // a stable subject across rotations.
      return { ok: true, subject: account.id, actorContext };
    } catch {
      // try next attempt
    }
  }

  // Opaque token fallback — Better Auth's client_credentials flow issues
  // opaque tokens (stored as SHA-256 base64url in oauthAccessToken). The
  // JWT path above only handles signed JWTs; this path handles the opaque
  // case by hashing the raw token and looking it up directly in the DB.
  //
  // The previous opaque-token fallback SELECTed only "clientId" and built the
  // actor with an
  // EMPTY payload, so tokenScopes collapsed to undefined and enforceRunAccess
  // SKIPPED the scope ceiling — AND it never bound audience, so a token minted
  // for a DIFFERENT resource replayed into A2A. Hardened here:
  //   (1) SELECT the row's real stored scopes and feed them through the same
  //       account-ceiling intersection as the JWT path (empty => [] deny-all,
  //       never undefined — fail-closed scope behavior).
  //   (2) AUDIENCE/RESOURCE BINDING: the oauthAccessToken row has no audience
  //       column, so we bind by the A2A-specific `a2a:connect` scope. A token
  //       lacking `a2a:connect` in its STORED scopes is rejected — an opaque
  //       token minted for another resource cannot replay into A2A by token
  //       value alone. (a2a:connect is resource-specific, so this is a true
  //       resource gate, not merely a scope gate.)
  //   (3) confirm the matched clientId maps to a genuine, non-revoked
  //       service_accounts row (a real client_credentials principal) before
  //       promoting it to a ServiceAccount actor.
  try {
    const tokenHash = createHash("sha256").update(accessToken).digest("base64url");
    const rows = await betterAuthDb.execute<{ clientId: string; scopes: unknown }>(sql`
      SELECT "clientId", "scopes" FROM public."oauthAccessToken"
      WHERE token = ${tokenHash}
        AND "expiresAt" > now()
      LIMIT 1
    `);
    const row = (rows as { rows?: Array<{ clientId: string; scopes: unknown }> }).rows?.[0];
    if (row?.clientId) {
      const account = await readServiceAccountByClientId(row.clientId);
      if (account && account.revokedAt === null) {
        // Normalize the stored scopes to a space-separated string (Better Auth
        // stores OAuth scopes as a string; tolerate a JSON-array shape too).
        const storedScopeString = normalizeStoredScopes(row.scopes);
        // (2) AUDIENCE BINDING via the A2A-specific connect scope. `a2a:connect`
        // is a CONNECT scope (not in PERMISSION_SET, so parseTokenScopes would
        // drop it) — check the RAW stored scope tokens. Reject opaque tokens
        // not granted a2a:connect: they were not minted for the A2A resource and
        // must not replay into it by token value alone.
        const rawStoredScopeTokens = storedScopeString.trim().split(/\s+/);
        if (!rawStoredScopeTokens.includes("a2a:connect")) {
          return { ok: false, response: unauthorized(req) };
        }
        // (1) Feed the real stored scopes through the account-ceiling
        // intersection (same path as JWTs). tokenScopes becomes a concrete
        // array; an empty intersection deny-alls in enforceRunAccess.
        const actorContext = buildActorContextFromServiceAccountJwt(
          { scope: storedScopeString },
          account,
        );
        return { ok: true, subject: account.id, actorContext };
      }
    }
  } catch {
    // non-fatal — fall through to 401
  }

  return { ok: false, response: unauthorized(req) };
}

/**
 * Normalize a stored OAuth `scopes` column value into a space-separated string
 * for `parseTokenScopes`. Better Auth stores OAuth scopes as a space-separated
 * string; this also tolerates a JSON-array shape defensively. Any other shape
 * yields an empty string (=> deny-all after intersection).
 */
function normalizeStoredScopes(scopes: unknown): string {
  if (typeof scopes === "string") return scopes;
  if (Array.isArray(scopes)) {
    return scopes.filter((s): s is string => typeof s === "string").join(" ");
  }
  return "";
}

/**
 * Verify a Bearer token for the internal LangGraph LLM bridge endpoint.
 *
 * Accepts EITHER:
 *   • A2A tokens  (aud=/api/a2a,  scope=a2a:connect) — future-proof path
 *   • MCP tokens  (aud=/api/mcp,  scope=mcp:connect) — LLM MCP client_credentials
 *
 * MCP credentials may still use mcp:connect scope; the bridge must accept both
 * token types until those credentials are migrated.
 */
export async function verifyLangGraphBridgeToken(req: Request): Promise<A2AAuthResult> {
  if (process.env.A2A_DEV_BYPASS === "true" && isLocalhostRequest(req)) {
    return { ok: true, subject: "dev-bypass" };
  }

  // Strict Bearer-prefix enforcement (no permissive fallback).
  const authorizationHeader = req.headers.get("authorization");
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return { ok: false, response: unauthorized(req) };
  }
  const accessToken = authorizationHeader.slice("Bearer ".length).trim();
  if (!accessToken) {
    return { ok: false, response: unauthorized(req) };
  }

  const canonicalOrigin = inferLocalAppOrigin();
  const authClient = createServerAuthClient({
    plugins: [oauthProviderResourceClient(auth as unknown as Auth)],
  });

  // Scope checks are enforced separately from these audience attempts.
  const attempts = [
    { audience: `${canonicalOrigin}${A2A_BASE_PATH}` },
    { audience: `${canonicalOrigin}${MCP_BASE_PATH}` },
  ];

  for (const attempt of attempts) {
    try {
      // Split signature/expiry (401) from scope mismatch (403). Do not
      // pass `scopes:` here; the bridge endpoint is internal-only and
      // audience routing alone is a sufficient gate.
      await authClient.verifyAccessToken(accessToken, {
        verifyOptions: {
          audience: attempt.audience,
          issuer: `${canonicalOrigin}${AUTH_BASE_PATH}`,
        },
        jwksUrl: `${canonicalOrigin}${AUTH_BASE_PATH}/jwks`,
      });
      const subject = extractJwtSubject(accessToken) ?? accessToken;
      return { ok: true, subject };
    } catch {
      // try next attempt
    }
  }

  return { ok: false, response: unauthorized(req) };
}

/**
 * Decodes the JWT payload segment (base64url) and returns the `sub` claim.
 * Returns undefined if the token is malformed or sub is absent. Caller must
 * only invoke after verifyAccessToken has already validated the signature.
 */
function extractJwtSubject(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract claims from a JWT payload AFTER signature verification has
 * succeeded (caller's responsibility — see `authClient.verifyAccessToken`
 * above). The decode is non-validating; it only reads claims from a token
 * whose signature is already trusted.
 *
 * Non-string claims are dropped (returned as undefined) — empty strings,
 * numeric `org_id`, object claims, and missing fields all coerce to
 * undefined. Absent or invalid claims become undefined so the handler can
 * decide whether to reject actors with no organization.
 *
 * Private to this file — do NOT export.
 */
function extractJwtClaims(token: string): { sub?: string; org_id?: string } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return {};
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const sub = typeof payload.sub === "string" ? payload.sub : undefined;
    const orgId =
      typeof payload.org_id === "string" && payload.org_id.length > 0
        ? payload.org_id
        : undefined;
    return { sub, org_id: orgId };
  } catch {
    return {};
  }
}

function unauthorized(req: Request): Response {
  const origin = safeOrigin(req);
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function safeOrigin(req: Request): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return inferLocalAppOrigin();
  }
}

// ---------------------------------------------------------------------------
// JWT payload extraction + ActorContext builder + forbidden helper
// ---------------------------------------------------------------------------

/**
 * A2A JWT custom-claim shape. Extracted AFTER signature/expiry verification
 * has already succeeded — never trust this payload before then.
 *
 * Better Auth's oauth-provider sets `azp = clientId` and leaves
 * `sub` undefined for client_credentials grants; introspection responses
 * additionally carry `client_id`. The verifier resolves the principal id
 * via `client_id ?? azp ?? sub` (matching mcp-server/src/index.tsx:518-537).
 */
type A2AJwtPayload = {
  sub?: string;
  azp?: string;
  client_id?: string;
  org_id?: string;
  scope?: string;
  agent_id?: string;
  delegated_by?: string;
};

/**
 * Decode the JWT payload segment (base64url) into the typed A2A shape.
 * Returns null for malformed tokens (wrong segment count, invalid base64).
 *
 * Caller MUST only invoke this AFTER `authClient.verifyAccessToken()` has
 * confirmed the signature — this function does NOT verify anything.
 */
export function extractA2AJwtPayload(token: string): A2AJwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as A2AJwtPayload;
  } catch {
    return null;
  }
}

/**
 * Build an ActorContext for a service-account principal from JWT claims +
 * the service_accounts row. organizationId is read from the row (NOT the JWT)
 * to ensure JWTs that omit org_id do NOT default to "any
 * org" in that case.
 *
 * Enforce `effectiveScopes = jwtScopes ∩ accountScopes` so the
 * admin-configured per-account scope ceiling is load-bearing. The
 * `service_accounts.scopes` column must be read so the Developers UI promise
 * of scope gating is load-bearing.
 * The token cannot exceed the account ceiling: a token issued with
 * `scope=mcp:connect a2a:connect` against an account configured with
 * `scopes="run.read"` collapses to an empty intersection (and any
 * permission check falls through to deny in enforceRunAccess).
 */
export function buildActorContextFromServiceAccountJwt(
  payload: A2AJwtPayload,
  account: ServiceAccountRecord,
): ScopedA2AServiceAccountContext {
  const jwtScopes = parseTokenScopes(payload.scope);
  const accountScopes = parseTokenScopes(account.scopes);
  // A token must not exceed its account's scope ceiling.
  const effectiveScopes = jwtScopes.filter((s) => accountScopes.includes(s));
  return {
    principalType: "ServiceAccount",
    // Stable principalId from row PK; the JWT's clientId rotates.
    principalId: account.id,
    organizationId: account.orgId ?? undefined,
    authSource: "a2a",
    // ALWAYS emit a concrete array for ServiceAccount/a2a actors — never
    // `undefined`. enforceRunAccess SKIPS the token-scope ceiling when
    // tokenScopes is undefined (the "non-A2A actor, no restriction" path), so
    // collapsing an empty intersection to undefined let an A2A token with an
    // absent / non-intersecting scope claim bypass its scope ceiling. An empty
    // array deny-alls in enforceRunAccess (the intended fail-closed behavior).
    tokenScopes: effectiveScopes,
    delegatedBy: payload.delegated_by ?? undefined,
    policyVersion: POLICY_VERSION,
  };
}

/**
 * 403 Forbidden response for valid-but-insufficient-scope tokens. Mirrors
 * the shape of `unauthorized()` but carries a 403 status. This preserves the
 * split between 401 (auth failure) and 403 (authz failure).
 *
 * Currently unused by verifyA2AAccessToken itself — exported for the
 * scope-intersection layer (`enforceRunAccess`).
 */
export function forbidden(req: Request): Response {
  const origin = safeOrigin(req);
  return new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}
