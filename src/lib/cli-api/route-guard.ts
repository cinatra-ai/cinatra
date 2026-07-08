// ---------------------------------------------------------------------------
// Shared authorization guard for the `/api/cli/*` instance control-plane.
//
// cinatra#255 (G2). These endpoints re-home today's direct-Postgres Class-A
// CLI commands (`cinatra status`, `cinatra agent export|import`,
// `cinatra agents install`) onto authenticated server contracts so the
// published `cinatra` bin can drive a *remote* instance as an ordinary
// OAuth API client — without shipping `pg` / DB credentials.
//
// AUTHENTICATION — reuses the EXISTING surface; invents nothing:
//   * A Better-Auth session resolved through `auth.api.getSession({ headers })`
//     — i.e. a cookie session (or a Better-Auth session token the resolver
//     accepts). The token is NOT decoded-and-trusted here; the resolver
//     verifies it. We never read claims from an undecoded token.
//   * Dev-admin loopback bypass (`shouldGrantDevAdminBypass`) for the
//     local-CLI → local-instance path, gated by the SAME three guards as the
//     MCP transport: `NODE_ENV !== production` + `CINATRA_MCP_DEV_ADMIN_BYPASS=true`
//     + a trusted-dev host. This is what makes `cinatra status` against your
//     OWN dev box work without an OAuth dance, exactly as the MCP path already
//     does.
//
// REMOTE BEARER (the CLI-audience decision record §2d, D2-A) — a remote OAuth Bearer is resolved here
// for SCOPED routes ONLY, via `verifyCliBearer`: the token must JWKS-verify
// against the DEDICATED `/api/cli` audience (`aud=<origin>/api/cli`) AND carry
// the route's `cli:*` scope. An MCP-only token (bound to `aud=<origin>/api/mcp`)
// is REJECTED — the audiences are deliberately separate so an `mcp:connect`
// token can never become a CLI control-plane token (the audience-confusion
// hole). A route that declares NO `requiredScope` is never reachable by a
// remote Bearer at all. The actor (platform/org role) is resolved fail-closed
// from the VERIFIED identity, never a token claim. So this guard now authorizes
// three paths: an established Better-Auth session, a verified `/api/cli` Bearer
// (scoped routes), or the dev-admin loopback bypass — and fails closed
// otherwise.
//
// AUTHORIZATION — scope admits, ROLE authorizes (codex G2 decision):
//   The OAuth `mcp:connect` scope is the admission ticket, but it must NEVER
//   by itself grant control-plane authority. We resolve the role from the
//   authenticated identity, not from a token claim, and gate per-endpoint:
//
//     * `minTier: "org-admin"` (default) — `platform_admin` OR an active-org
//       `org_owner` / `org_admin`.
//     * `minTier: "platform-admin"` — `platform_admin` (or the loopback
//       dev-admin bypass) ONLY. Used by endpoints whose underlying read/write
//       is NOT org-scoped (agent export/import query `agent_templates` by
//       id/name with no org predicate), so an org-admin must NOT get
//       cross-org reach. (codex review: org-admins are not given global agent
//       access.)
//
// NO new OAuth scope is minted here — the admin-only operator scope is
// deferred to the G3 security-hardening track, and NO remote-destructive
// command is exposed by this guard (status + agent export/import/install are
// read / authoring only).
// ---------------------------------------------------------------------------

import { headers as nextHeaders } from "next/headers";

import { auth } from "@/lib/auth";
import {
  isPlatformAdmin,
  resolveOrgRoleForUser,
  type AuthzOrgRole,
} from "@/lib/auth-session";
import {
  isTrustedDevHost,
  shouldGrantDevAdminBypass,
} from "@cinatra-ai/mcp-server/dev-admin-bypass";
import { verifyCliBearer } from "@/lib/cli-api/verify-cli-bearer";

/** The role tiers permitted to drive the CLI control plane. */
const AUTHORIZED_ORG_ROLES: ReadonlySet<AuthzOrgRole> = new Set<AuthzOrgRole>([
  "org_owner",
  "org_admin",
]);

export type CliActor = {
  /** Authenticated user id, or `null` for the loopback dev-admin bypass. */
  userId: string | null;
  /** True when the resolved identity is a platform admin. */
  isPlatformAdmin: boolean;
  /** Active-org role (when resolvable), used for the org-admin tier. */
  orgRole?: AuthzOrgRole;
  /** Active organization id resolved for this request, when known. */
  organizationId: string | null;
  /**
   * How the caller was authorized. `dev-admin-bypass` marks the loopback path
   * (no real session); `session` marks a cookie/Bearer session;
   * `verified-bearer` marks a remote OAuth Bearer JWKS-verified against the
   * dedicated `/api/cli` audience + a `cli:*` scope (the CLI-audience decision record §2d).
   */
  via: "session" | "dev-admin-bypass" | "verified-bearer";
};

export type CliGuardSuccess = { ok: true; actor: CliActor };
export type CliGuardFailure = { ok: false; status: 401 | 403; error: string };
export type CliGuardResult = CliGuardSuccess | CliGuardFailure;

/** Minimum role tier an endpoint requires. Defaults to `org-admin`. */
export type CliAuthTier = "org-admin" | "platform-admin";

export type AuthorizeCliOptions = {
  /** Minimum tier required. `platform-admin` excludes org owners/admins. */
  minTier?: CliAuthTier;
  /**
   * The dedicated `cli:*` scope a REMOTE OAuth Bearer must carry to authorize
   * this route (the CLI-audience decision record §2d). REQUIRED for the verified-Bearer path to be
   * attempted — when omitted, a remote Bearer is NOT resolved and falls through
   * to the dev-bypass / 401 (a route that does not declare a scope can never be
   * driven by a remote token). A cookie session / dev-admin bypass ignore it.
   */
  requiredScope?: string;
};

/**
 * Resolve and authorize the caller of a `/api/cli/*` route.
 *
 * Order:
 *   1. Try the authenticated session (cookie / session token). When present,
 *      authorize on platform-admin / org-admin role.
 *   2. Else, when the route declares a `cli:*` scope and a Bearer is present,
 *      try the remote OAuth Bearer verified against the `/api/cli` audience
 *      (the CLI-audience decision record §2d). Fail-closed; a missing/invalid Bearer falls through.
 *   3. Else, try the dev-admin loopback bypass (local CLI → local box).
 *   4. Otherwise deny (401 if unauthenticated, 403 if authenticated but
 *      under-privileged).
 *
 * Never throws on auth failure — returns a typed failure the route turns into
 * a JSON response. Unexpected internal errors propagate to the route's 500.
 */
export async function authorizeCliRequest(
  request: Request,
  options?: AuthorizeCliOptions,
): Promise<CliGuardResult> {
  const minTier: CliAuthTier = options?.minTier ?? "org-admin";
  const requestHeaders = await nextHeaders();

  // ---- 1. Established Better-Auth session (cookie / session token). -------
  // `auth.api.getSession` verifies the credential; we read identity ONLY from
  // the resolved session, never from an unverified decode of the raw header.
  // (Remote OAuth Bearer tokens are NOT resolved by this call — see the
  // SCOPE BOUNDARY note above; they fail closed to the 401 below.)
  const session = await auth.api
    .getSession({ headers: requestHeaders })
    .catch(() => null);

  if (session?.user?.id) {
    const platformAdmin = isPlatformAdmin(session);
    const organizationId = session.session?.activeOrganizationId ?? null;
    const orgRole = organizationId
      ? await resolveOrgRoleForUser(organizationId, session.user.id)
      : undefined;

    const orgAdminTier =
      orgRole !== undefined && AUTHORIZED_ORG_ROLES.has(orgRole);
    const authorized =
      minTier === "platform-admin"
        ? platformAdmin
        : platformAdmin || orgAdminTier;

    if (!authorized) {
      return {
        ok: false,
        status: 403,
        error:
          minTier === "platform-admin"
            ? "Forbidden: this CLI endpoint requires platform admin."
            : "Forbidden: the CLI control plane requires platform admin or an organization owner/admin role.",
      };
    }

    return {
      ok: true,
      actor: {
        userId: session.user.id,
        isPlatformAdmin: platformAdmin,
        ...(orgRole ? { orgRole } : {}),
        organizationId,
        via: "session",
      },
    };
  }

  // ---- 2. Remote OAuth Bearer verified against the `/api/cli` audience. ----
  // the CLI-audience decision record §2d (D2-A). Only attempted when the route declares a `cli:*` scope
  // AND the request carries an Authorization header. `verifyCliBearer` is
  // fail-closed: it JWKS-verifies the token against `aud=<origin>/api/cli` +
  // the required scope, rejects any token also bound to `/api/mcp`, and
  // resolves the actor (platform-admin / org-role) from the VERIFIED identity
  // — never a token role claim. A null result here is NOT a hard deny: it
  // falls through to the dev-bypass / 401 below so a missing/invalid Bearer
  // behaves exactly as it does today.
  if (options?.requiredScope && request.headers.get("authorization")) {
    const verified = await verifyCliBearer(request, options.requiredScope).catch(
      () => null,
    );
    if (verified) {
      const orgAdminTier =
        verified.orgRole !== undefined &&
        AUTHORIZED_ORG_ROLES.has(verified.orgRole);
      const authorized =
        minTier === "platform-admin"
          ? verified.isPlatformAdmin
          : verified.isPlatformAdmin || orgAdminTier;

      if (!authorized) {
        return {
          ok: false,
          status: 403,
          error:
            minTier === "platform-admin"
              ? "Forbidden: this CLI endpoint requires platform admin."
              : "Forbidden: the CLI control plane requires platform admin or an organization owner/admin role.",
        };
      }

      return {
        ok: true,
        actor: {
          userId: verified.userId,
          isPlatformAdmin: verified.isPlatformAdmin,
          ...(verified.orgRole ? { orgRole: verified.orgRole } : {}),
          organizationId: verified.organizationId,
          via: "verified-bearer",
        },
      };
    }
    // A present-but-invalid Bearer falls through to the dev-bypass / 401 — it
    // is never silently upgraded, and the 401 below tells the caller to re-auth.
  }

  // ---- 3. Dev-admin loopback bypass (local CLI → local instance). ---------
  // SAME guards the MCP transport uses; never fires in production.
  const url = request.url;
  const trustedDevHost = isTrustedDevHost({
    nodeEnv: process.env.NODE_ENV,
    envBypassFlag: process.env.CINATRA_MCP_DEV_ADMIN_BYPASS,
    trustedHostsEnv: process.env.CINATRA_MCP_DEV_TRUSTED_HOSTS,
    urlHost: safeUrlHost(url),
    forwardedHostRaw: requestHeaders.get("x-forwarded-host"),
  });

  const grantBypass = shouldGrantDevAdminBypass({
    nodeEnv: process.env.NODE_ENV,
    envBypassFlag: process.env.CINATRA_MCP_DEV_ADMIN_BYPASS,
    isTrustedDevHost: trustedDevHost,
  });

  if (grantBypass) {
    return {
      ok: true,
      actor: {
        userId: null,
        isPlatformAdmin: true,
        organizationId: null,
        via: "dev-admin-bypass",
      },
    };
  }

  // ---- 4. Deny (fail closed). ---------------------------------------------
  // Reached when there is no established session, no valid `/api/cli`-audience
  // Bearer for a scoped route, AND the loopback bypass did not apply. Failing
  // closed here is intentional; an unverified/under-scoped Bearer is never
  // silently accepted.
  return {
    ok: false,
    status: 401,
    error:
      "Unauthorized: sign in to this instance (or run against a trusted dev host with the admin bypass enabled).",
  };
}

/** Extract just the host portion of a request URL; null on a malformed URL. */
function safeUrlHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
