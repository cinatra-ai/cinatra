import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { auth, ensureGoogleAvatarSync, ensureInitialAdminBootstrap, ensureDefaultOrganizationMembership, ensureAssistantBootstrap } from "@/lib/auth";
import { betterAuthDb, betterAuthMembers } from "@/lib/better-auth-db";
import { notifPerf, notifPerfNote, notifPerfNow } from "@cinatra-ai/notifications/perf-log";

// Run once per server process to seed any missing built-in assistant users
// (currently just @cinatra). Idempotent
// — each seed checks existence first.
let assistantBootstrapDone: Promise<void> | null = null;
function runAssistantBootstrapOnce(): Promise<void> {
  if (!assistantBootstrapDone) {
    assistantBootstrapDone = ensureAssistantBootstrap().catch(() => {
      assistantBootstrapDone = null; // allow retry on next request if it errored
    }) as Promise<void>;
  }
  return assistantBootstrapDone;
}

let __getAuthSessionCalls = 0;

export async function getAuthSession() {
  // Auth-session performance instrumentation. The call# counter exposes how
  // many getAuthSession() round-trips a single request makes; /notifications
  // should make one route-local call.
  const __t0 = notifPerfNow();
  notifPerfNote("getAuthSession.call#", ++__getAuthSessionCalls);
  void runAssistantBootstrapOnce();
  const __tH = notifPerfNow();
  const requestHeaders = await headers();
  notifPerf("getAuthSession.headers", __tH);
  const __tS1 = notifPerfNow();
  const session = await auth.api.getSession({
    headers: requestHeaders,
  });
  notifPerf("getAuthSession.getSession#1", __tS1);

  if (!session) {
    notifPerf("getAuthSession.TOTAL(noSession)", __t0);
    return session;
  }

  const hasAvatar = Boolean(String(session.user.image ?? "").trim());
  const hasRole = Boolean(String(session.user.role ?? "").trim()) && session.user.role !== "user";
  const hasActiveOrg = Boolean(session.session?.activeOrganizationId);

  if (hasAvatar && hasRole && hasActiveOrg) {
    notifPerf("getAuthSession.TOTAL(fastPath)", __t0);
    return session;
  }

  const __tE = notifPerfNow();
  // The member_org_user_uniq DB constraint enforces one membership
  // row per (organizationId, userId), so correctness no longer depends on
  // ordering; running ensureInitialAdminBootstrap first is belt-and-suspenders
  // for the promote-to-owner UPDATE timing.
  const bootstrapped = hasRole ? false : await ensureInitialAdminBootstrap(session.user.id);
  const [avatarSynced, orgEnsured] = await Promise.all([
    hasAvatar ? Promise.resolve(false) : ensureGoogleAvatarSync(session.user.id),
    hasActiveOrg ? Promise.resolve(false) : ensureDefaultOrganizationMembership(session.user.id),
  ]);
  notifPerf("getAuthSession.enrichment", __tE);

  if (!bootstrapped && !avatarSynced && !orgEnsured) {
    notifPerf("getAuthSession.TOTAL(enrichNoop)", __t0);
    return session;
  }

  const __tS2 = notifPerfNow();
  const reSession = await auth.api.getSession({
    headers: requestHeaders,
  });
  notifPerf("getAuthSession.getSession#2", __tS2);
  notifPerf("getAuthSession.TOTAL(reGet)", __t0);
  return reSession;
}

export async function requireAuthSession() {
  const session = await getAuthSession();

  if (!session) {
    redirect("/sign-in");
  }

  return session;
}

export async function requireAdminSession() {
  const session = await requireAuthSession();
  const roles = String(session.user.role ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!roles.includes("admin")) {
    redirect("/not-authorized");
  }

  return session;
}

/**
 * Pure predicate for "does this session belong to a platform admin?".
 *
 * Better Auth's admin plugin stores roles as a comma-separated string
 * ("user,admin"), so naive `session.user.role === "admin"` checks miss
 * any user with a multi-role string. This helper reuses the canonical
 * comma-split pattern from `requireAdminSession` above and from
 * `src/lib/authz/enforce.ts:buildActorContext`.
 *
 * Use this everywhere a server action / server component needs to ask
 * "is the caller an admin?" without the side-effect of redirecting.
 */
export function isPlatformAdmin(
  session: { user?: { role?: string | null } | null } | null | undefined,
): boolean {
  return String(session?.user?.role ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes("admin");
}

// ---------------------------------------------------------------------------
// Resolve Better Auth's organization plugin `member.role` value into the
// authz kernel's `orgRole` value, then build the `opts` object expected by
// `canDo(session, perm, resource?, opts?)`.
//
// Better Auth writes "owner" | "admin" | "member" to public."member".role.
// The authz kernel (src/lib/authz/enforce.ts:resolveRoles) expects
// "org_owner" | "org_admin" | "member". We perform the mapping in ONE
// place so test fixtures stay aligned with production code.
// ---------------------------------------------------------------------------

type SessionWithUserAndActiveOrg = {
  user: { id: string };
  session?: { activeOrganizationId?: string | null } | null;
};

export type AuthzOrgRole = "org_owner" | "org_admin" | "member";

/**
 * Look up the caller's role in their currently active organization, mapping
 * Better Auth's `member.role` value into the authz kernel's `orgRole` value.
 *
 * Returns `undefined` when:
 *   - The session has no `activeOrganizationId` (no DB query attempted)
 *   - The user has no membership row in the active org
 *   - The role string is unknown (defensive — should not happen in practice)
 */
/**
 * Per-request cached lookup keyed by `(orgId, userId)`. The cache scope is
 * a single React render pass — multiple call sites in one request (server
 * action gate + screen-level admin-button visibility) hit the DB once.
 */
const cachedResolveOrgRole = cache(
  async (orgId: string, userId: string): Promise<AuthzOrgRole | undefined> => {
    const rows = await betterAuthDb
      .select({ role: betterAuthMembers.role })
      .from(betterAuthMembers)
      .where(
        and(
          eq(betterAuthMembers.organizationId, orgId),
          eq(betterAuthMembers.userId, userId),
        ),
      )
      .limit(1);

    const raw = rows[0]?.role ?? undefined;
    if (raw === "owner") return "org_owner";
    if (raw === "admin") return "org_admin";
    if (raw === "member") return "member";
    return undefined;
  },
);

export async function resolveOrgRoleForSession(
  session: SessionWithUserAndActiveOrg,
): Promise<AuthzOrgRole | undefined> {
  const orgId = session.session?.activeOrganizationId ?? undefined;
  if (!orgId) return undefined;
  return cachedResolveOrgRole(orgId, session.user.id);
}

/**
 * Resolve the active-org role for a (orgId, userId) pair directly from the
 * membership table — for actor paths that carry ids but no resolved orgRole
 * (e.g. the MCP token context, which carries platformRole only). Per-request
 * cached. The artifact/workflow extension-access gates use this so the
 * owner-aware `admin` tier recognizes org admins/owners on the MCP path.
 */
export async function resolveOrgRoleForUser(
  orgId: string,
  userId: string,
): Promise<AuthzOrgRole | undefined> {
  return cachedResolveOrgRole(orgId, userId);
}

/**
 * Convenience wrapper that constructs the `opts` object expected by
 * `canDo(session, perm, resource?, opts?)`. When `resolveOrgRoleForSession`
 * returns undefined, returns an empty object so the kernel falls back to
 * its defaults (no synthetic org_admin role).
 */
export async function buildCanDoOptsFromSession(
  session: SessionWithUserAndActiveOrg,
): Promise<{ orgRole?: AuthzOrgRole }> {
  const orgRole = await resolveOrgRoleForSession(session);
  return orgRole ? { orgRole } : {};
}

// ---------------------------------------------------------------------------
// Actor-context helpers for server actions and page components that must
// resolve a real Principal instead of relying on a process-wide LOCAL_USER_ID
// constant.
// ---------------------------------------------------------------------------

import { buildActorContext } from "@/lib/authz/enforce";
import type { ActorContext, ProjectGrant } from "@/lib/authz/actor-context";
import { readTeamsForUser, readProjectGrantsForUser } from "@/lib/better-auth-db";

/**
 * Resolve the canonical project grants for a session, threaded into
 * `buildActorContext` via `opts.projectGrants`.
 *
 * Project resolution in the session lineage gives chat actions / skills pages
 * via `requireActorContext` project visibility. Existing callers that ignore
 * projectIds keep working because the binary `projectIds` shortcut is kept in
 * lockstep; callers that need grants receive them.
 *
 * Hints available in the session lineage:
 *  - `orgRole`  — via `resolveOrgRoleForSession` (active-org-scoped).
 *  - `teamIds`  — via `readTeamsForUser` (active-org-scoped). Needed for
 *    Source 2's `principal_team_id = ANY(teamIds)` UNION branch.
 *  - `teamRoles` — NOT resolvable: `public."teamMember"` has no `role`
 *    column (Better Auth team plugin stores no per-team role; verified in
 *    better-auth-db.ts:93). Missing teamRoles degrade a team-owned implicit
 *    grant to `{read, team}` — safe (never over-grants) and preserves the
 *    binary projectIds back-compat (the project still appears in projectGrants
 *    → projectIds).
 *
 * Always returns an array (possibly `[]` = "resolved, none"). The caller
 * passes it as `opts.projectGrants` so `buildActorContext` marks the context
 * RESOLVED. When the session has no userId/activeOrganizationId we still
 * return `[]` (resolved-empty) — the session lineage is a human path that
 * should be marked resolved, just with no grants.
 */
async function resolveProjectGrantsForSession(
  session: { user?: { id?: string | null } | null; session?: { activeOrganizationId?: string | null } | null },
): Promise<ProjectGrant[]> {
  const userId = session.user?.id ?? null;
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!userId || !orgId) return [];
  const orgRole = await resolveOrgRoleForSession(
    session as SessionWithUserAndActiveOrg,
  );
  const teams = await readTeamsForUser(userId, orgId);
  return readProjectGrantsForUser(userId, orgId, {
    teamIds: teams.map((t) => t.id),
    ...(orgRole ? { orgRole } : {}),
  });
}

/**
 * Resolve an ActorContext for the caller. Returns `undefined` when the
 * request has no auth session.
 */
export async function getActorContext(): Promise<ActorContext | undefined> {
  const session = await getAuthSession();
  if (!session) return undefined;
  const orgRole = await resolveOrgRoleForSession(session);
  const projectGrants = await resolveProjectGrantsForSession(session);
  return buildActorContext(session, {
    ...(orgRole ? { orgRole } : {}),
    projectGrants,
  });
}

/**
 * Resolve an ActorContext for the caller; redirects to `/sign-in` when no
 * session exists.
 */
export async function requireActorContext(): Promise<ActorContext> {
  const session = await requireAuthSession();
  const orgRole = await resolveOrgRoleForSession(session);
  const projectGrants = await resolveProjectGrantsForSession(session);
  return buildActorContext(session, {
    ...(orgRole ? { orgRole } : {}),
    projectGrants,
  });
}

// ---------------------------------------------------------------------------
// Cookie-less context resolution
//
// For callers authenticated via a non-cookie mechanism (e.g. MCP OAuth Bearer
// JWT resolved to a userId upstream), reconstruct the session-shape that
// buildActorContext expects. Used by chat_thread_send so it can drive the
// chat orchestration in-process without a second HTTP roundtrip through
// /api/chat (which only authenticates via cookie).
// ---------------------------------------------------------------------------

import { betterAuthUsers, betterAuthSessions } from "@/lib/better-auth-db";

export type ResolvedUserContext = {
  actorContext: ActorContext;
  platformRole: "platform_admin" | "member";
  sessionOrgId: string | null;
};

export type ResolveUserContextOpts = {
  /**
   * Override for the active organization. When provided, skip the DB lookup
   * and use this value directly. Callers that already have the user's
   * verified active org from the same request (e.g. MCP transport context,
   * better-auth session) should pass it here to avoid picking an arbitrary
   * session row from the DB.
   */
  activeOrganizationId?: string | null;
  /**
   * Override for platform role. Same rationale as activeOrganizationId.
   */
  platformRole?: "platform_admin" | "member";
};

export async function resolveUserContextForUserId(
  userId: string,
  opts?: ResolveUserContextOpts,
): Promise<ResolvedUserContext> {
  const userRows = await betterAuthDb
    .select({ id: betterAuthUsers.id, role: betterAuthUsers.role })
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.id, userId))
    .limit(1);

  const user = userRows[0];
  if (!user) {
    throw new Error(`resolveUserContextForUserId: user ${userId} not found`);
  }

  let activeOrganizationId: string | null = opts?.activeOrganizationId ?? null;
  if (!activeOrganizationId) {
    // Prefer a real session row (matches cookie-path behaviour); fall back to
    // default-org bootstrap so first-time MCP callers get a usable org.
    const sessionRows = await betterAuthDb
      .select({ activeOrganizationId: betterAuthSessions.activeOrganizationId })
      .from(betterAuthSessions)
      .where(eq(betterAuthSessions.userId, userId))
      .limit(1);
    activeOrganizationId = sessionRows[0]?.activeOrganizationId ?? null;
    if (!activeOrganizationId) {
      await ensureDefaultOrganizationMembership(userId);
      const memberRows = await betterAuthDb
        .select({ organizationId: betterAuthMembers.organizationId })
        .from(betterAuthMembers)
        .where(eq(betterAuthMembers.userId, userId))
        .limit(1);
      activeOrganizationId = memberRows[0]?.organizationId ?? null;
    }
  }

  const syntheticSession = {
    user: { id: user.id, role: user.role ?? null },
    session: { activeOrganizationId },
  };

  const platformRole: "platform_admin" | "member" =
    opts?.platformRole ?? (isPlatformAdmin(syntheticSession) ? "platform_admin" : "member");

  const orgRole = activeOrganizationId
    ? await cachedResolveOrgRole(activeOrganizationId, userId)
    : undefined;

  // Resolve project grants for this user in the supplied active org.
  // Background runs (skill-autosave) pass run.orgId in
  // `opts.activeOrganizationId`, so Sources 2+3 (project_access /
  // co-owner) are scoped to the run's org (NOT an arbitrary default-org
  // fallback). If `activeOrganizationId` is unavailable here we cannot
  // safely resolve Sources 2+3 (no org anchor → stale-membership guard +
  // active-org predicate cannot fire), so we FAIL CLOSED for those and
  // return only Source 1 (implicit owned via readProjectGrantsForUser's
  // self-anchored owner clauses). The caller of resolveUserContextForUserId
  // is responsible for supplying an authoritative active org.
  let projectGrants: ProjectGrant[] = [];
  if (activeOrganizationId) {
    const teams = await readTeamsForUser(userId, activeOrganizationId);
    projectGrants = await readProjectGrantsForUser(userId, activeOrganizationId, {
      teamIds: teams.map((t) => t.id),
      ...(orgRole ? { orgRole } : {}),
    });
  } else {
    // No active-org anchor → only Source 1 can run safely. The default
    // `listAccessibleOrgIdsForUser` check would short-circuit Sources 2+3
    // anyway, but we surface this explicitly so the failure mode is
    // documented (callers that observe `[]` for a real user know to supply
    // an org).
    projectGrants = await readProjectGrantsForUser(userId, "", {});
  }

  const actorContext = buildActorContext(syntheticSession, {
    ...(orgRole ? { orgRole } : {}),
    projectGrants,
  });

  return { actorContext, platformRole, sessionOrgId: activeOrganizationId };
}
