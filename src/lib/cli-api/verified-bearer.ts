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
//     `cli:agent:read` / `cli:agent:write` / `cli:extensions:read` /
//     `cli:extensions:write`) — no "any cli:* scope" fallback.
//   * The actor's ROLE is resolved LIVE from the verified subject via
//     `resolveUserContextForUserId` (never trusted from a token claim). The
//     route's `minTier` gate (applied by `authorizeCliRequest`) is the real
//     authority boundary: an arbitrary client that obtains the scope+audience
//     still resolves to ITS OWN user and fails the platform-admin gate.
//   * GRANT-TYPE branching is EXPLICIT and keyed on `sub` PRESENCE (#2479 —
//     see the GRANT DISCRIMINATION note below): a user-delegated
//     (`authorization_code`) token resolves the user; a `client_credentials`
//     token (client identity, NO `sub`; requires a `service_accounts` row)
//     resolves to `created_by` but carries NO platform role — so it is
//     admitted yet authorized for NO platform-admin route today (D7). A token
//     that fits NEITHER arm cleanly is REJECTED.
//   * Audience + issuer come from CANONICAL config (`inferLocalAppOrigin()` /
//     `NEXT_PUBLIC_APP_URL`), NEVER from request `Host` / `x-forwarded-*`.
//
// Mirrors the proven `verifyA2AAccessToken` JWKS pattern in
// `src/lib/a2a-auth.ts` (verify signature/aud/iss → decode claims AFTER verify
// → fail-closed), adapted to resolve an authorization_code user subject.
//
// ---------------------------------------------------------------------------
// GRANT DISCRIMINATION (#2479) — `sub` PRESENCE, never `azp`.
//
// This resolver originally routed on `payload.client_id ?? payload.azp`. That
// premise ("an interactive token carries no client-credential identity claim")
// is FALSE against this authorization server, and the consequence was measured
// live in cinatra-cli#204: a real `cinatra login` token — admin user, correct
// `/api/cli` audience, correct scope, valid signature — was refused 401.
//
// Read from `@better-auth/oauth-provider@1.6.23` (`createJwtAccessToken`), the
// ONLY mint path behind `<origin>/api/auth/oauth2/token`:
//
//     payload = { sub: user?.id, aud, azp: client.clientId, scope, sid, ... }
//
//   * `azp` is stamped with the OAuth client id for **BOTH** grants — it is an
//     "authorized party" claim, NOT a grant-type discriminator. OIDC in fact
//     REQUIRES it once `aud` is multi-valued, which it is here (the `openid`
//     scope appends the userinfo audience to the RFC 8707 `resource`), so the
//     interactive shape is precisely `aud: [<origin>/api/cli, …]` + `azp` set.
//   * `sub` is `user?.id` — populated ONLY when a user row is passed, which
//     `handleAuthorizationCodeGrant` / `handleRefreshTokenGrant` always do and
//     `handleClientCredentialsGrant` never does ("the concept of a user id does
//     not exist on the token", per its own doc comment).
//   * `client_id` is NEVER minted as an access-token claim by this AS at all
//     (the provider only synthesizes it in the RFC 7662 *introspection*
//     response). Cinatra adds exactly one custom claim, `jti`
//     (`mintAccessTokenJtiClaims`), and no `client_id`.
//
// So `client_id ?? azp` was ALWAYS truthy on a verified token and EVERY caller
// took the machine arm. Routing on `sub` presence is the same discriminator
// `packages/mcp-server/src/actor-identity.ts` already adopted for the MCP
// transport (#1592), whose own regression suite names "the CLI verified-bearer
// branch-order defect (azp-first)" as the thing it guards against. This change
// brings the CLI resolver onto that settled doctrine.
//
// This is a ROUTING fix, not a relaxation. Every check a token had to pass
// still applies, unchanged and in the same order (Bearer prefix → JWKS
// signature/aud/iss → EXACT scope → arm), and the classifier is strictly
// FAIL-CLOSED: a shape that is not unambiguously one arm or the other is
// rejected outright rather than guessed at. `sub` is trusted here — unlike the
// MCP transport's decode-without-verify seam — ONLY because it is read after
// `verifyAccessToken` has proven this AS signed the token.
// ---------------------------------------------------------------------------

const CLI_BASE_PATH = "/api/cli";
const AUTH_BASE_PATH = "/api/auth";

/** The exact CLI scopes; one is required per endpoint. */
export type CliScope =
  | "cli:status"
  | "cli:agent:read"
  | "cli:agent:write"
  | "cli:extensions:read"
  | "cli:extensions:write";

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
  sub?: unknown;
  azp?: unknown;
  client_id?: unknown;
  scope?: unknown;
};

/**
 * Read one identity claim, distinguishing ABSENT from MALFORMED (codex round 2).
 *
 *   `undefined` — the key is absent. A legitimate shape for `sub` on a
 *                 client_credentials token and for `client_id` on every token
 *                 this AS mints.
 *   `null`      — the key is PRESENT but not a canonical non-empty string:
 *                 wrong type, explicit null, empty, or whitespace-padded. The
 *                 classifier treats this as an ambiguous shape and fails
 *                 closed. It deliberately does NOT normalize (trim) the value:
 *                 silently canonicalizing a padded identifier would route a
 *                 token this AS cannot mint, and "reject" is the stricter and
 *                 more honest answer than "repair".
 *   `string`    — a usable, already-canonical identifier.
 */
function readIdentityClaim(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  if (value.length === 0 || value !== value.trim()) return null;
  return value;
}

/**
 * The arm a verified token is routed to. `unknown` is the FAIL-CLOSED bucket —
 * the resolver denies rather than guessing at an ambiguous shape.
 */
export type CliTokenShape =
  | { arm: "user-delegated"; subject: string }
  | { arm: "machine-client"; clientIdentity: string }
  | { arm: "unknown" };

/**
 * Classify a VERIFIED token's claims into exactly one arm (#2479). Pure and
 * exported so the routing contract is directly unit-testable, and total: every
 * input lands in exactly one branch.
 *
 *   * USER-DELEGATED — a real-user `sub` and no `client_id` identity claim.
 *     `azp` is IGNORED here: this AS stamps it on every grant, and a
 *     multi-valued `aud` (the interactive shape, `openid` + RFC 8707
 *     `resource`) makes it mandatory under OIDC. The audience itself was
 *     already pinned by `verifyAccessToken`, so it needs no re-inspection.
 *   * MACHINE-CLIENT — a client identity (`client_id`, else `azp`) and NO
 *     `sub`, which is exactly what `handleClientCredentialsGrant` mints. The
 *     `client_id ?? azp` lookup-key precedence is preserved verbatim from the
 *     pre-#2479 arm, so a real service-account token keys off the SAME value
 *     and hits the SAME `service_accounts` row it always did.
 *   * UNKNOWN (fail closed) — no identity claim at all; a `sub` together with
 *     an explicit `client_id`; or ANY identity claim present in a malformed
 *     form. The `sub`+`client_id` case is contradictory (a machine identity
 *     claim on a user-subject token); this AS cannot mint it, and denying is
 *     strictly stronger than the pre-#2479 behavior of silently admitting it
 *     through the machine arm.
 */
export function classifyCliTokenShape(payload: CliJwtPayload): CliTokenShape {
  const subject = readIdentityClaim(payload.sub);
  const clientIdClaim = readIdentityClaim(payload.client_id);
  const azpClaim = readIdentityClaim(payload.azp);

  // A PRESENT-but-malformed identity claim anywhere makes the shape ambiguous:
  // reject rather than proceed as though it were absent.
  if (subject === null || clientIdClaim === null || azpClaim === null) {
    return { arm: "unknown" };
  }

  if (subject === undefined) {
    const clientIdentity = clientIdClaim ?? azpClaim;
    return clientIdentity
      ? { arm: "machine-client", clientIdentity }
      : { arm: "unknown" };
  }

  if (clientIdClaim !== undefined) return { arm: "unknown" };
  return { arm: "user-delegated", subject };
}

/**
 * Decode the JWT payload AFTER `verifyAccessToken` has confirmed the
 * signature/aud/iss. Non-validating; never trust this before verification.
 */
function decodeCliJwtPayload(token: string): CliJwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const decoded: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    // A JWT payload is a JSON OBJECT (RFC 7519 §7.2). A bare scalar or an
    // array parses fine but is not a claims set — reject rather than let the
    // classifier read `undefined` off it.
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      return null;
    }
    return decoded as CliJwtPayload;
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

  // ---- 4. EXPLICIT grant-type branching, keyed on `sub` presence (#2479). --
  // See the GRANT DISCRIMINATION note at the top of this module: `azp` is
  // stamped on BOTH grants by this AS, so it cannot discriminate; a real-user
  // `sub` is minted ONLY by the user-delegated grants. An ambiguous shape is
  // rejected outright rather than routed on a guess.
  const shape = classifyCliTokenShape(payload);

  if (shape.arm === "unknown") return null;

  if (shape.arm === "machine-client") {
    // ---- 4a. client_credentials arm (UNCHANGED). --------------------------
    // Require a real, non-revoked service_accounts row. Resolves to the
    // creator's userId but carries NO platform role (D7): it can be admitted
    // but is authorized for NO platform-admin route today. Never synthesize a
    // platform role for a service account.
    const account = await readServiceAccountByClientId(
      shape.clientIdentity,
    ).catch(() => null);
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

  // ---- 4b. user-delegated (authorization_code / refresh_token) arm. -------
  // A verified real-user subject — this is the arm a real `cinatra login`
  // token takes as of #2479. Resolve the LIVE platform/org role from the DB
  // (never a token claim). Deny on no-row / error (fail closed). The route's
  // `minTier` gate in `authorizeCliRequest` is still the authority boundary:
  // a non-admin subject is admitted here and denied there.
  const sub = shape.subject;

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
