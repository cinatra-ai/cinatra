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
// REMOTE BEARER (CLI Class-A) — a remote OAuth Bearer is resolved
// by `resolveCliBearerActor` (src/lib/cli-api/verified-bearer.ts) ONLY when the
// endpoint declares a `requiredScope`. The resolver JWKS-verifies the token
// against the DEDICATED `/api/cli` audience (reciprocal isolation from the
// `/api/mcp` audience), enforces the EXACT endpoint scope, and resolves the
// actor's role LIVE from the verified subject (never from a token claim). The
// route's `minTier` gate below then authorizes — so an arbitrary client that
// obtains the scope+audience still resolves to its OWN user and fails the
// platform-admin gate. An endpoint that omits `requiredScope` does NOT invoke
// the Bearer arm: a remote Bearer FAILS CLOSED (401) there, exactly as before.
// Destructive/operator commands stay gated on the operator-mutation chokepoint and are never reachable
// through this guard (status + agent export/import are read / authoring only).
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
import {
  resolveCliBearerActor,
  type CliScope,
} from "@/lib/cli-api/verified-bearer";

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
   * (no real session); `session` marks a cookie session; `bearer` marks a
   * verified remote OAuth Bearer.
   */
  via: "session" | "dev-admin-bypass" | "bearer";
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
   * The EXACT CLI scope a remote Bearer must carry to authorize this endpoint
   * (CLI Class-A remote Bearer). REQUIRED to enable remote-Bearer auth: an endpoint that omits
   * it never invokes the Bearer arm, so a remote Bearer fails closed there.
   */
  requiredScope?: CliScope;
};

/**
 * Resolve and authorize the caller of a `/api/cli/*` route.
 *
 * Order:
 *   1. Try the authenticated cookie session. When present, authorize on
 *      platform-admin / org-admin role.
 *   2. (CLI Class-A) When the endpoint declares `requiredScope`, try a verified
 *      remote OAuth Bearer via `resolveCliBearerActor`. Audience-pinned,
 *      scope-gated, role resolved live from the verified subject.
 *   3. Otherwise, try the dev-admin loopback bypass (local CLI → local box).
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

    if (!isTierAuthorized(minTier, platformAdmin, orgRole)) {
      return tierForbidden(minTier);
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

  // ---- 2. Verified remote OAuth Bearer (CLI Class-A). --------------------
  // ONLY when the endpoint declares a `requiredScope`. The resolver is
  // fail-closed: wrong/missing audience, opaque/expired token, missing scope,
  // or an unresolvable subject all return null (→ falls through to the bypass
  // / 401 below). The role tier is then applied to the LIVE-resolved actor,
  // exactly as for a session — so a remote Bearer must clear the SAME
  // platform-admin / org-admin gate, never a token-claimed role.
  if (options?.requiredScope) {
    const bearerActor = await resolveCliBearerActor(
      request,
      options.requiredScope,
    );
    if (bearerActor) {
      if (
        !isTierAuthorized(minTier, bearerActor.isPlatformAdmin, bearerActor.orgRole)
      ) {
        return tierForbidden(minTier);
      }
      return { ok: true, actor: bearerActor };
    }
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
  // Reached when there is no established session, no verified CLI Bearer (or
  // the endpoint declares no `requiredScope`), AND the loopback bypass did not
  // apply. Failing closed here is intentional; a remote Bearer is never
  // silently accepted — it must clear audience + scope + the role tier above.
  return {
    ok: false,
    status: 401,
    error:
      "Unauthorized: sign in to this instance (or run against a trusted dev host with the admin bypass enabled).",
  };
}

/**
 * Apply the `minTier` role gate to a resolved actor's role facts. Shared by
 * the session and verified-Bearer arms so both enforce the SAME authority
 * boundary (platform-admin for the platform-admin tier; platform-admin OR an
 * active-org owner/admin for the org-admin tier).
 */
function isTierAuthorized(
  minTier: CliAuthTier,
  isPlatformAdmin: boolean,
  orgRole: AuthzOrgRole | undefined,
): boolean {
  if (minTier === "platform-admin") return isPlatformAdmin;
  const orgAdminTier = orgRole !== undefined && AUTHORIZED_ORG_ROLES.has(orgRole);
  return isPlatformAdmin || orgAdminTier;
}

/** The 403 a route returns when an authenticated actor is under the tier. */
function tierForbidden(minTier: CliAuthTier): CliGuardFailure {
  return {
    ok: false,
    status: 403,
    error:
      minTier === "platform-admin"
        ? "Forbidden: this CLI endpoint requires platform admin."
        : "Forbidden: the CLI control plane requires platform admin or an organization owner/admin role.",
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
