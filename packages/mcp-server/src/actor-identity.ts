// ---------------------------------------------------------------------------
// resolveActorIdentity
//
// Pure function composing three identity sources in priority order so the MCP
// transport handler can populate mcpRequestContextStorage.userId for cookieless
// requests (Claude Code on localhost, tunneled service-accounts) without losing
// the existing cookie-session regression.
//
// Priority:
//   1. cookie session     (sessionUser?.id)                       — existing
//   2. Bearer JWT clientId → service_accounts.{created_by, org_id}, the org
//      composed ONLY behind a live `public.member` gate (#1545; see the arm)
//   3. localhost dev fallback (A2A_DEV_BYPASS + isLocalhost)
//      → SELECT id FROM public."user" WHERE role='admin'
//        ORDER BY "createdAt" ASC LIMIT 1                         — new
//
// Returns a COHERENT `{ userId, orgId }` pair (#1545): when the Bearer /
// service-account arm resolves the identity, it also carries the
// `organizationId` from the SAME service_accounts row it already reads, so the
// transport can stamp a server-derived org onto the request frame instead of
// dropping it (the org-less-Bearer defect). `orgId` is server-derived ONLY —
// it is the `org_id` column of the matched service_accounts row, never a
// caller-suppliable operand. The cookie and localhost-admin arms return
// `orgId: null`: their org is resolved by the transport from
// `session.activeOrganizationId` / the dev first-org fallback respectively, so
// this function never overrides those coherent sources.
//
// Mirrors the existing resolvedOrgId fallback at index.tsx ~973-980 exactly.
// All DB reads are non-fatal: any error → fall through to null and let
// downstream authz deny.
// ---------------------------------------------------------------------------

import type { ServiceAccountActorIdentity } from "./service-accounts";

export type ActorIdentityPool = {
  query<T = unknown>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type ResolveActorIdentityInput = {
  /** Session user from `auth.api.getSession({ headers })`, or undefined when no cookie. */
  sessionUser: { id?: string | null } | undefined;
  /** Decoded JWT clientId from `decodeJwtClientId(authHeader)`, or undefined. */
  requestClientId: string | undefined;
  /** The incoming Request (used only for env/isLocalhost decisions by the caller). */
  request: Request;
  /** Subset of process.env passed in for testability. */
  env: { A2A_DEV_BYPASS?: string };
  /** Result of `isLocalhostRequest(request)` — passed in to keep this module pure. */
  isLocalhost: boolean;
  /** Service-account lookup. Defaults to readServiceAccountByClientId. */
  readServiceAccount: (
    clientId: string,
  ) => Promise<ServiceAccountActorIdentity | null>;
  /** DB pool for the first-admin localhost fallback (betterAuthPool in prod). */
  pool: ActorIdentityPool;
};

/**
 * A coherent actor identity pair resolved from ONE source. `userId` is null
 * when no source yields a usable id (caller leaves it null → downstream authz
 * denies). `orgId` is non-null ONLY on the service-account arm, where it is the
 * server-derived `org_id` of the SAME matched service_accounts row; the cookie
 * and localhost-admin arms leave it null (the transport owns those orgs).
 */
export type ResolvedActorIdentity = {
  userId: string | null;
  orgId: string | null;
};

/**
 * True iff a live `public.member` row exists for the exact `{orgId, userId}`
 * pair. Used to gate service-account org composition (#1545) so a stale
 * `service_accounts.org_id` never re-admits a creator whose membership was
 * revoked. FAIL-CLOSED: any DB error returns `false` (→ org-less at this arm),
 * so a transient failure can never admit an unverified org binding; the normal
 * boundary then denies `not_org_member` (absent a dev-only bypass).
 */
export async function orgMembershipExists(input: {
  orgId: string;
  userId: string;
  pool: ActorIdentityPool;
}): Promise<boolean> {
  const { orgId, userId, pool } = input;
  try {
    const result = await pool.query<{ one: number }>(
      'SELECT 1 AS one FROM public."member" WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1',
      [orgId, userId],
    );
    return result.rows.length > 0;
  } catch (error) {
    // Fail CLOSED: a membership-check error must NOT compose the org.
    console.warn("[actor-identity] org-membership existence check failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Resolve the `{ userId, orgId }` pair to attach to mcpRequestContextStorage.
 * Returns `{ userId: null, orgId: null }` when no source yields a usable id —
 * caller must then leave userId null and let downstream authz deny per the
 * existing contract. When the service-account arm matches, `orgId` carries that
 * row's `organizationId` so the transport stamps a server-derived org for
 * Bearer callers (#1545) instead of dropping it.
 */
export async function resolveActorIdentity(
  input: ResolveActorIdentityInput,
): Promise<ResolvedActorIdentity> {
  const { sessionUser, requestClientId, env, isLocalhost, readServiceAccount, pool } = input;

  // 1. Cookie session wins if present (regression preserved). Its org is
  //    resolved by the transport from session.activeOrganizationId, so we
  //    return orgId:null here and never override that coherent source.
  if (sessionUser?.id) return { userId: sessionUser.id, orgId: null };

  // 2. Bearer-token / service-account path. The org is composed from the SAME
  //    row as the userId (server-derived, coherent pair) — this is the #1545
  //    fix: previously only `userId` was carried and `organizationId` dropped.
  //
  //    LIVE-MEMBERSHIP GATE (fail-closed): the service_accounts row's `org_id`
  //    proves the account's PROVENANCE, not the creator's CURRENT membership.
  //    Nothing revokes a service account when its creator is removed from the
  //    org, so composing the stale `org_id` unconditionally would re-admit an
  //    ex-member — silently converting the boundary's `not_org_member` deny
  //    into an allow (the boundary trusts a present `orgId` as membership
  //    proof). We therefore compose the org ONLY when a live `public.member`
  //    row exists for the exact `{org_id, created_by}` pair; otherwise the
  //    identity stays org-less at this arm and the boundary denies (contract
  //    preserved) unless a dev-only bypass later supplies an org. The userId is
  //    still carried (audit/provenance); org-less alone denies in production.
  if (requestClientId) {
    const account = await readServiceAccount(requestClientId);
    if (account?.userId) {
      const orgId =
        account.organizationId &&
        (await orgMembershipExists({
          orgId: account.organizationId,
          userId: account.userId,
          pool,
        }))
          ? account.organizationId
          : null;
      return { userId: account.userId, orgId };
    }
  }

  // 3. Localhost dev fallback — gated on BOTH A2A_DEV_BYPASS=true AND
  //    isLocalhostRequest(request). Mirrors resolvedOrgId fallback shape. Org
  //    stays null: the transport's A2A first-org fallback owns the dev org.
  if (env.A2A_DEV_BYPASS === "true" && isLocalhost) {
    try {
      const result = await pool.query<{ id: string }>(
        'SELECT id FROM public."user" WHERE role = \'admin\' ORDER BY "createdAt" ASC LIMIT 1',
      );
      const id = result.rows[0]?.id;
      if (id) return { userId: id, orgId: null };
    } catch (error) {
      // non-fatal — fall through to null. Logged so operators can diagnose
      // dev-mode regressions when the localhost-admin lookup fails.
      console.warn("[actor-identity] localhost-admin lookup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { userId: null, orgId: null };
}

// ---------------------------------------------------------------------------
// pickServerDerivedOrgId
//
// The precedence + coherence gate the transport applies when stamping the
// verified-Bearer service-account org onto the request frame (#1545). Pure and
// synchronous so the precedence contract is directly unit-testable:
//
//   * A higher-precedence org (delegated OBO `orgId`, cookie
//     `session.activeOrganizationId`, or the trusted-dev coherent pair) has
//     ALREADY been assigned to `currentOrgId` before this runs — it is NEVER
//     overridden.
//   * Otherwise the actor-identity org is adopted ONLY when it is paired with
//     its OWN resolved userId (the identity actually came from
//     `resolveActorIdentity`, not a delegated/trusted-dev source). This
//     coherence guard guarantees the stamped `{ userId, orgId }` come from the
//     same service_accounts row — a service-account org is never paired with a
//     different identity.
//   * Else null → the boundary denies `not_org_member` (fail-closed). There is
//     no first-membership fallback: an identity with no server-derivable org
//     stays org-less.
//
// The dev-only A2A_DEV_BYPASS first-org fallback runs AFTER this in the
// transport and fills the org ONLY when it is still null — so a real verified
// Bearer org always wins over the dev fallback.
// ---------------------------------------------------------------------------
export function pickServerDerivedOrgId(input: {
  currentOrgId: string | null;
  actorIdentity: ResolvedActorIdentity | null;
  resolvedUserId: string | null;
}): string | null {
  const { currentOrgId, actorIdentity, resolvedUserId } = input;
  // Never override an already-resolved higher-precedence org.
  if (currentOrgId) return currentOrgId;
  // Adopt the actor-identity org only when coherently paired with its own id.
  if (
    actorIdentity?.orgId &&
    actorIdentity.userId != null &&
    resolvedUserId === actorIdentity.userId
  ) {
    return actorIdentity.orgId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// composeBearerActorContext
//
// The transport-level composition the MCP handler applies ONCE, BEFORE its
// dev-only A2A first-org fallbacks, so a verified Bearer caller's SERVER-DERIVED
// org (the matched service_accounts row's `org_id`) takes precedence over the
// dev first-org fallback (#1545). It consults `resolveActorIdentity` ONLY when
// neither a delegated OBO token nor the trusted-dev coherent pair already
// resolved a userId — preserving the exact prior `userId` short-circuit (no
// extra DB read for delegated/trusted-dev callers) — then applies
// `pickServerDerivedOrgId` to stamp the server-derived org.
//
// Bearer org composition precedence (#1545), SERVER-DERIVED ONLY — no arm reads
// a caller-suppliable org operand:
//   1. delegated OBO `orgId`                    (caller's `currentOrgId`)
//   2. cookie `session.activeOrganizationId`    (caller's `currentOrgId`)
//   3. trusted-dev coherent `{userId, orgId}`   (dev only; caller's inputs)
//   4. verified-Bearer service-account `org_id` (← this composition; the fix)
//   5. A2A_DEV_BYPASS first-org                 (dev only; caller, iff still null)
// A Bearer identity with no server-derivable org yields `resolvedOrgId: null`;
// in production (no dev bypass) the boundary then denies `not_org_member`
// (fail-closed, unchanged). There is deliberately NO silent first-membership
// pick for a multi-org identity: the service-account arm carries exactly its
// row's `org_id` (behind the live-membership gate above), and no arm enumerates
// memberships to guess one.
// ---------------------------------------------------------------------------
export async function composeBearerActorContext(input: {
  /** Org already resolved by a higher-precedence source (delegated OBO / cookie / trusted-dev), or null. */
  currentOrgId: string | null;
  /** Delegated OBO token userId (the human chat user), or null/undefined when absent. */
  delegatedUserId: string | null | undefined;
  /** Trusted-dev coherent-pair admin userId, or null/undefined when absent. */
  trustedDevAdminUserId: string | null | undefined;
  sessionUser: { id?: string | null } | undefined;
  requestClientId: string | undefined;
  request: Request;
  /** `process.env.A2A_DEV_BYPASS`, threaded through for testability. */
  a2aDevBypass: string | undefined;
  isLocalhost: boolean;
  readServiceAccount: (
    clientId: string,
  ) => Promise<ServiceAccountActorIdentity | null>;
  pool: ActorIdentityPool;
}): Promise<{ resolvedUserId: string | null; resolvedOrgId: string | null }> {
  const {
    currentOrgId,
    delegatedUserId,
    trustedDevAdminUserId,
    sessionUser,
    requestClientId,
    request,
    a2aDevBypass,
    isLocalhost,
    readServiceAccount,
    pool,
  } = input;
  // Consult resolveActorIdentity (a DB read) ONLY when neither delegated nor
  // trusted-dev already resolved a userId — the exact prior short-circuit.
  const actorIdentity =
    delegatedUserId || trustedDevAdminUserId
      ? null
      : await resolveActorIdentity({
          sessionUser,
          requestClientId,
          request,
          env: { A2A_DEV_BYPASS: a2aDevBypass },
          isLocalhost,
          readServiceAccount,
          pool,
        });
  const resolvedUserId =
    delegatedUserId ?? trustedDevAdminUserId ?? actorIdentity?.userId ?? null;
  const resolvedOrgId = pickServerDerivedOrgId({
    currentOrgId,
    actorIdentity,
    resolvedUserId,
  });
  return { resolvedUserId, resolvedOrgId };
}

// ---------------------------------------------------------------------------
// resolveOrgRoleFromMembership
//
// Resolves the caller's role in the active organization ONCE at transport
// context-build time so `mcpRequestContextStorage.orgRole` carries it natively
// to MCP handlers (issue: gates previously re-resolved it on demand per gate).
//
// Mapping mirrors `cachedResolveOrgRole` in src/lib/auth-session.ts exactly:
// better-auth membership `owner` → "org_owner", `admin` → "org_admin",
// `member` → "member", anything else / no row → undefined. Non-fatal on DB
// error → undefined; downstream gates keep their on-demand
// `resolveOrgRoleForUser` fallback, so a failed lookup never widens access.
// ---------------------------------------------------------------------------

export type McpOrgRole = "org_owner" | "org_admin" | "member";

/** Pure better-auth membership-role → kernel orgRole mapping. */
export function mapMembershipRoleToOrgRole(
  raw: string | null | undefined,
): McpOrgRole | undefined {
  if (raw === "owner") return "org_owner";
  if (raw === "admin") return "org_admin";
  if (raw === "member") return "member";
  return undefined;
}

/**
 * Read the membership row for (orgId, userId) and map its role. Callers must
 * pass the SAME (orgId, userId) pair that is stamped on the request store —
 * the resulting orgRole is only meaningful for that identity pair.
 */
export async function resolveOrgRoleFromMembership(input: {
  orgId: string | null | undefined;
  userId: string | null | undefined;
  pool: ActorIdentityPool;
}): Promise<McpOrgRole | undefined> {
  const { orgId, userId, pool } = input;
  if (!orgId || !userId) return undefined;
  try {
    const result = await pool.query<{ role: string | null }>(
      'SELECT role FROM public."member" WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1',
      [orgId, userId],
    );
    return mapMembershipRoleToOrgRole(result.rows[0]?.role);
  } catch (error) {
    // non-fatal — undefined keeps existing per-gate fallback behavior.
    console.warn("[actor-identity] org-role membership lookup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
