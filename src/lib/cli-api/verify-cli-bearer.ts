// ---------------------------------------------------------------------------
// verifyCliBearer — resolve a REMOTE OAuth Bearer into a fail-closed CLI actor
// for the `/api/cli/*` control-plane (the CLI-audience decision record §2d, D2-A).
//
// The existing `authorizeCliRequest` only resolves a Better-Auth SESSION
// (cookie/session-token) or the dev-admin loopback bypass; a remote OAuth
// Bearer falls through to 401. This module closes that gap WITHOUT opening the
// audience-confusion hole:
//
//   * A token is accepted ONLY when it is JWKS-verified against the DEDICATED
//     `/api/cli` audience (`aud=<origin>/api/cli`) for a trusted origin AND
//     carries the required `cli:*` scope. An MCP-only token (bound to
//     `aud=<origin>/api/mcp`) FAILS verification here by exact-audience match,
//     and a deliberately multi-audience token that also carries `/api/mcp` is
//     rejected by a post-verify audience allowlist (`cliAudienceClaimIsAcceptable`).
//   * The ACTOR is then resolved fail-closed from the VERIFIED identity, never
//     from a token role claim:
//       - `sub` present  -> user lookup -> platform-admin / org-role from the DB.
//       - else a `client_credentials` token -> its `client_id` must map to a
//         live `service_accounts` row -> `created_by` user (NO platform role is
//         derived from a service account today — the CLI-audience decision record D7 defers CI remote,
//         so such a token resolves to a non-platform-admin actor that cannot
//         reach the platform-admin routes).
//   * ANY failure — unverified signature, wrong/missing audience, missing
//     scope, unresolvable user, revoked service account — returns `null` (deny).
//     The resolver NEVER defaults to admin and NEVER trusts an unverified claim.
//
// Verification reuses the SAME `@better-auth/oauth-provider` resource-client +
// JWKS the MCP transport uses, so issuance (the `/api/cli` audience registered
// in `createMcpServerAuthPlugins`) and verification cannot drift.
// ---------------------------------------------------------------------------

import "server-only";

import type { Auth } from "better-auth";
import { createAuthClient as createServerAuthClient } from "better-auth/client";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";

import {
  cliAudienceForOrigin,
  cliAudienceClaimIsAcceptable,
  combineOriginAndPath,
} from "@cinatra-ai/mcp-server/cli-audience";
import { getTrustedTokenOrigins } from "@cinatra-ai/mcp-server/credentials";

import { auth } from "@/lib/auth";
import { readServiceAccountByClientId } from "@cinatra-ai/mcp-server/service-accounts";
import { readUserIsPlatformAdmin, betterAuthPool } from "@/lib/better-auth-db";
import { resolveOrgRoleForUser, type AuthzOrgRole } from "@/lib/auth-session";

const AUTH_BASE_PATH = "/api/auth";

/** The resolved actor a verified CLI Bearer maps to. */
export type VerifiedCliActor = {
  /** Verified user id (the token `sub`, or a service account's `created_by`). */
  userId: string;
  /** True only when the resolved user is a platform admin (DB-derived). */
  isPlatformAdmin: boolean;
  /** Active-org role, when resolvable, for the org-admin tier. */
  orgRole?: AuthzOrgRole;
  /** Active organization id, when known. */
  organizationId: string | null;
  /** The OAuth grant family the token was issued under. */
  grantType: "authorization_code" | "client_credentials";
};

type JwtPayloadLike = {
  sub?: unknown;
  aud?: unknown;
  scope?: unknown;
  client_id?: unknown;
  azp?: unknown;
  gty?: unknown;
  grant_type?: unknown;
};

function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const token = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : header.trim();
  return token.length > 0 ? token : null;
}

/**
 * Verify a remote CLI Bearer and resolve a fail-closed actor.
 *
 * @param request       The incoming request (its `Authorization` header).
 * @param requiredScope The `cli:*` scope the target route requires.
 * @returns A `VerifiedCliActor` on success, or `null` to DENY.
 */
export async function verifyCliBearer(
  request: Request,
  requiredScope: string,
): Promise<VerifiedCliActor | null> {
  const accessToken = extractBearer(request);
  if (!accessToken) return null;

  const origins = getTrustedTokenOrigins();
  const authClient = createServerAuthClient({
    plugins: [oauthProviderResourceClient(auth as unknown as Auth)],
  });

  // Verify against EACH trusted origin's `/api/cli` audience. The verifier
  // enforces exact-audience match + the required scope against JWKS; the FIRST
  // origin that verifies wins. An MCP-only token never matches a `/api/cli`
  // audience and is therefore rejected by every iteration.
  let payload: JwtPayloadLike | null = null;
  for (const origin of origins) {
    try {
      const verified = (await authClient.verifyAccessToken(accessToken, {
        verifyOptions: {
          audience: cliAudienceForOrigin(origin),
          issuer: combineOriginAndPath(origin, AUTH_BASE_PATH),
        },
        jwksUrl: `${combineOriginAndPath(origin, AUTH_BASE_PATH)}/jwks`,
        scopes: [requiredScope],
      })) as JwtPayloadLike;
      payload = verified;
      break;
    } catch {
      // try the next trusted origin
    }
  }
  if (!payload) return null;

  // Post-verify audience allowlist (codex MAJOR): reject a deliberately
  // multi-audience token that ALSO carries an `/api/mcp` resource audience —
  // a CLI token must be bound to the CLI resource and never double as an MCP
  // token. JOSE's array-audience match would otherwise let such a token pass.
  if (!cliAudienceClaimIsAcceptable(payload.aud, origins)) return null;

  // Belt-and-suspenders: the resource-client already enforced the scope, but
  // re-assert it here so a future verifier change can never silently drop it.
  if (!tokenHasScope(payload.scope, requiredScope)) return null;

  const grantType = inferGrantType(payload);

  // --- Resolve the actor fail-closed from the VERIFIED identity. -----------
  // Priority: a verified `sub` (interactive authorization_code) wins. Only a
  // sub-less token falls back to the service-account path.
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (sub) {
    return await buildActorForUser(sub, "authorization_code");
  }

  // client_credentials: the token has no human `sub`; map its client_id to a
  // live service-account row -> created_by user. No row / revoked => deny.
  void grantType;
  const clientId =
    typeof payload.client_id === "string"
      ? payload.client_id
      : typeof payload.azp === "string"
        ? payload.azp
        : "";
  if (!clientId) return null;
  const account = await readServiceAccountByClientId(clientId);
  if (!account?.userId) return null;
  return await buildActorForUser(account.userId, "client_credentials", account.organizationId);
}

/**
 * Build the actor for a verified user id, resolving platform-admin + the
 * active-org role from the DB. The platform-admin flag is ALWAYS derived from
 * the DB (`readUserIsPlatformAdmin`), never from a token claim.
 */
async function buildActorForUser(
  userId: string,
  grantType: "authorization_code" | "client_credentials",
  serviceAccountOrgId?: string | null,
): Promise<VerifiedCliActor | null> {
  let isPlatformAdmin = false;
  try {
    isPlatformAdmin = await readUserIsPlatformAdmin(userId);
  } catch {
    // Fail closed: if we cannot prove platform-admin, the user is not one.
    isPlatformAdmin = false;
  }

  // Active organization: for an interactive token, read the user's active org
  // from their most recent session; for a service account, use its bound org.
  const organizationId =
    grantType === "client_credentials"
      ? (serviceAccountOrgId ?? null)
      : await readActiveOrganizationId(userId);

  let orgRole: AuthzOrgRole | undefined;
  if (organizationId) {
    try {
      orgRole = await resolveOrgRoleForUser(organizationId, userId);
    } catch {
      orgRole = undefined; // fail closed: no org-admin tier without a proven role
    }
  }

  return {
    userId,
    isPlatformAdmin,
    ...(orgRole ? { orgRole } : {}),
    organizationId,
    grantType,
  };
}

/**
 * Read the user's active organization id from their most recent session row.
 * Non-fatal: any error -> null (the actor then carries no org tier). This NEVER
 * widens access — a missing org only removes the org-admin path.
 */
async function readActiveOrganizationId(userId: string): Promise<string | null> {
  try {
    const result = await betterAuthPool.query<{ activeOrganizationId: string | null }>(
      'SELECT "activeOrganizationId" FROM public."session" WHERE "userId" = $1 AND "activeOrganizationId" IS NOT NULL ORDER BY "updatedAt" DESC LIMIT 1',
      [userId],
    );
    return result.rows[0]?.activeOrganizationId ?? null;
  } catch {
    return null;
  }
}

/** True when the space-delimited `scope` claim contains `requiredScope` (exact set membership). */
function tokenHasScope(scopeClaim: unknown, requiredScope: string): boolean {
  if (typeof scopeClaim !== "string") return false;
  return new Set(scopeClaim.split(/\s+/).filter(Boolean)).has(requiredScope);
}

/** Infer the grant family from common claims; default to authorization_code. */
function inferGrantType(payload: JwtPayloadLike): "authorization_code" | "client_credentials" {
  const gty =
    typeof payload.gty === "string"
      ? payload.gty
      : typeof payload.grant_type === "string"
        ? payload.grant_type
        : "";
  if (gty === "client_credentials") return "client_credentials";
  // A sub-less token is treated as a machine token regardless of the gty claim.
  if (typeof payload.sub !== "string" || payload.sub.trim() === "") {
    return "client_credentials";
  }
  return "authorization_code";
}
