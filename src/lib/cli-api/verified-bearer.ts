import "server-only";

import type { Auth } from "better-auth";
import { auth } from "@/lib/auth";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { createAuthClient as createServerAuthClient } from "better-auth/client";
import {
  resolveUserContextForUserId,
  resolveOrgRoleForUser,
  type AuthzOrgRole,
} from "@/lib/auth-session";
import { readServiceAccountByClientId } from "@/lib/service-accounts";

// ---------------------------------------------------------------------------
// Verified remote-Bearer actor resolver for the `/api/cli/*` control plane.
//
// CLI Class-A remote Bearer. `authorizeCliRequest` historically resolved ONLY a
// Better-Auth session or the dev-admin loopback bypass; a remote OAuth Bearer
// fell through to 401. This resolver makes an INTERACTIVE `cinatra login`
// token JWKS-verifiable as a remote Bearer for the READ/AUTHORING control
// plane — fail-closed, audience-pinned, scope-gated, role-authorized.
//
// SECURITY MODEL (codex-converged) — "scope admits, role authorizes":
//   * The token MUST carry `aud = <origin>/api/cli` (a DEDICATED audience,
//     NEVER the `/api/mcp` audience — reciprocal isolation: an `/api/mcp`
//     token is rejected here, and an `/api/cli` token is rejected by
//     `verifyMcpAccessToken`).
//   * The token MUST carry the EXACT endpoint scope (`cli:status` /
//     `cli:agent:read` / `cli:agent:write`) — no "any cli:* scope" fallback.
//   * The actor's ROLE is resolved LIVE from the verified subject via
//     `resolveUserContextForUserId` (never trusted from a token claim). The
//     route's `minTier` gate (applied by `authorizeCliRequest`) is the real
//     authority boundary: an arbitrary client that obtains the scope+audience
//     still resolves to ITS OWN user and fails the platform-admin gate.
//   * GRANT-TYPE branching is EXPLICIT (codex): an `authorization_code` token
//     (has a real-user `sub`, no `client_id`/`azp`) resolves the user; a
//     `client_credentials` token (carries `client_id`/`azp`, requires a
//     `service_accounts` row) resolves to `created_by` but carries NO platform
//     role — so it is admitted yet authorized for NO platform-admin route
//     today (D7). A token that fits NEITHER arm cleanly is REJECTED.
//   * Audience + issuer come from CANONICAL config (`inferLocalAppOrigin()` /
//     `NEXT_PUBLIC_APP_URL`), NEVER from request `Host` / `x-forwarded-*`.
//
// Mirrors the proven `verifyA2AAccessToken` JWKS pattern in
// `src/lib/a2a-auth.ts` (verify signature/aud/iss → decode claims AFTER verify
// → fail-closed), adapted to resolve an authorization_code user subject.
// ---------------------------------------------------------------------------

const CLI_BASE_PATH = "/api/cli";
const AUTH_BASE_PATH = "/api/auth";

/** The exact CLI scopes; one is required per endpoint. */
export type CliScope = "cli:status" | "cli:agent:read" | "cli:agent:write";

export type CliBearerActor = {
  /** Verified user id (authorization_code) or the service-account `created_by`. */
  userId: string;
  /** True only for an authorization_code subject resolved to platform_admin. */
  isPlatformAdmin: boolean;
  /** Active-org role when resolvable (for the org-admin tier). */
  orgRole?: AuthzOrgRole;
  /** Active organization id resolved for the subject, when known. */
  organizationId: string | null;
  /** Always `"bearer"` — distinguishes from session / dev-admin-bypass. */
  via: "bearer";
};

function inferLocalAppOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/**
 * The set of audiences the AS may mint for the CLI surface: the canonical
 * local origin and, when configured, the public origin — each suffixed with
 * `/api/cli`. Derived from canonical config ONLY (never request-derived), so
 * audience binding stays meaningful against a stable expected resource.
 */
function cliValidAudiences(): string[] {
  const out = new Set<string>();
  const local = inferLocalAppOrigin().replace(/\/+$/, "");
  out.add(`${local}${CLI_BASE_PATH}`);
  const publicAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (publicAppUrl) out.add(`${publicAppUrl}${CLI_BASE_PATH}`);
  return Array.from(out);
}

/** Exact whitespace-delimited token match on the `scope` claim (no substring). */
function tokenHasScope(scopeClaim: unknown, required: CliScope): boolean {
  if (typeof scopeClaim !== "string") return false;
  return scopeClaim.split(/\s+/).filter(Boolean).includes(required);
}

type CliJwtPayload = {
  sub?: string;
  azp?: string;
  client_id?: string;
  scope?: string;
};

/**
 * Decode the JWT payload AFTER `verifyAccessToken` has confirmed the
 * signature/aud/iss. Non-validating; never trust this before verification.
 */
function decodeCliJwtPayload(token: string): CliJwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as CliJwtPayload;
  } catch {
    return null;
  }
}

/**
 * Resolve and authorize a remote CLI Bearer to a real actor, or return `null`
 * (fail-closed) on ANY failure: malformed header, wrong/missing audience,
 * opaque/expired token, missing required scope, an unresolvable subject, or a
 * grant shape that does not fit exactly one arm.
 *
 * @param request the incoming request (Authorization header is read here).
 * @param requiredScope the EXACT scope the endpoint demands. A caller that
 *   omits this MUST NOT invoke the Bearer arm (the route guard enforces that).
 */
export async function resolveCliBearerActor(
  request: Request,
  requiredScope: CliScope,
): Promise<CliBearerActor | null> {
  // ---- 1. Strict RFC 6750 Bearer prefix. ----------------------------------
  const authorizationHeader = request.headers.get("authorization");
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const accessToken = authorizationHeader.slice("Bearer ".length).trim();
  if (!accessToken) return null;

  const canonicalOrigin = inferLocalAppOrigin().replace(/\/+$/, "");
  const audiences = cliValidAudiences();
  const authClient = createServerAuthClient({
    plugins: [oauthProviderResourceClient(auth as unknown as Auth)],
  });

  // ---- 2. JWKS-verify against the DEDICATED `/api/cli` audience(s). --------
  // An `/api/mcp` token (or any other audience) fails every attempt → null.
  // Opaque (client_credentials never passed `resource`) / expired → null.
  let verified = false;
  for (const audience of audiences) {
    try {
      await authClient.verifyAccessToken(accessToken, {
        verifyOptions: {
          audience,
          issuer: `${canonicalOrigin}${AUTH_BASE_PATH}`,
        },
        jwksUrl: `${canonicalOrigin}${AUTH_BASE_PATH}/jwks`,
      });
      verified = true;
      break;
    } catch {
      // try next configured CLI audience
    }
  }
  if (!verified) return null;

  // ---- 3. Decode claims AFTER verify; enforce the EXACT required scope. ----
  const payload = decodeCliJwtPayload(accessToken);
  if (!payload) return null;
  if (!tokenHasScope(payload.scope, requiredScope)) return null;

  // ---- 4. EXPLICIT grant-type branching (codex). --------------------------
  // A service token (client_credentials) carries `client_id`/`azp` and no
  // real-user `sub`. An interactive token (authorization_code) carries a
  // real-user `sub` and no client-credential identity claim. Route by the
  // presence of the client-credential identity claim, NEVER by "has sub"
  // alone — a client_credentials token must never fall into the user arm.
  const clientIdentity = payload.client_id ?? payload.azp;

  if (clientIdentity) {
    // ---- 4a. client_credentials arm. --------------------------------------
    // Require a real, non-revoked service_accounts row. Resolves to the
    // creator's userId but carries NO platform role (D7): it can be admitted
    // but is authorized for NO platform-admin route today. Never synthesize a
    // platform role for a service account.
    const account = await readServiceAccountByClientId(clientIdentity).catch(
      () => null,
    );
    if (!account || account.revokedAt !== null) return null;
    if (!account.createdBy) return null;

    const orgRole = account.orgId
      ? await resolveOrgRoleForUser(account.orgId, account.createdBy).catch(
          () => undefined,
        )
      : undefined;

    return {
      userId: account.createdBy,
      isPlatformAdmin: false,
      ...(orgRole ? { orgRole } : {}),
      organizationId: account.orgId ?? null,
      via: "bearer",
    };
  }

  // ---- 4b. authorization_code arm. ----------------------------------------
  // A verified real-user subject. Resolve the LIVE platform/org role from the
  // DB (never a token claim). Deny on no-row / error (fail closed).
  const sub = payload.sub;
  if (!sub) return null;

  try {
    const ctx = await resolveUserContextForUserId(sub);
    const organizationId = ctx.sessionOrgId;
    const orgRole = organizationId
      ? await resolveOrgRoleForUser(organizationId, sub).catch(() => undefined)
      : undefined;
    return {
      userId: sub,
      isPlatformAdmin: ctx.platformRole === "platform_admin",
      ...(orgRole ? { orgRole } : {}),
      organizationId,
      via: "bearer",
    };
  } catch {
    // unknown user / DB error → fail closed
    return null;
  }
}
