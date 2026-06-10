/**
 * Team-visibility widening policy for the teams dashboard cube (#69).
 *
 * Pure, dependency-injected decision logic — NO host imports — so the
 * RBAC branches are unit-testable without mocking the heavy
 * `@/lib/auth-session` / `@/lib/better-auth-db` module graphs (mirrors
 * the injectable-deps pattern of `readProjectGrantsForUser` and the
 * callback style of `security-context.ts`).
 *
 * Policy:
 *   - Direct team memberships are ALWAYS visible (the pre-#69 surface).
 *   - Actors whose active-org role is `org_admin` or `org_owner` are
 *     widened to EVERY team in the active org. The allowlist is explicit:
 *     `member`, `undefined` (no membership row), and any unknown role
 *     string all stay on the direct-membership set (fail closed).
 *   - Widening is active-org-scoped only. The org role is resolved per
 *     active org, so teams from other orgs in `accessibleOrgIds` are NOT
 *     included (multi-org widening is out of scope for #69).
 *   - Failures in the WIDENING path (role resolution or the org-wide team
 *     listing) degrade to the direct-membership set — never wider, and the
 *     dashboard stays useful for admins on a transient error. A failure in
 *     the DIRECT lookup still propagates so the caller's per-resolver
 *     `.catch(() => undefined)` fails the whole cube closed, same as today.
 *
 * Wired with real deps by `dashboard-visibility-resolvers.ts`.
 */

/** Active-org roles that widen team visibility beyond direct membership. */
export const TEAM_WIDENING_ORG_ROLES = ["org_owner", "org_admin"] as const;

export type TeamWideningOrgRole = (typeof TEAM_WIDENING_ORG_ROLES)[number];

export type TeamRow = { readonly id: string; readonly name: string };

export type TeamVisibilityDeps = {
  /** Direct memberships — the canonical `readTeamsForUser(userId, orgId)`. */
  readonly readTeamsForUser: (
    userId: string,
    orgId: string,
  ) => Promise<readonly TeamRow[]>;
  /** Org-wide team listing — the canonical `listTeamsForOrg(orgId)`. */
  readonly listTeamsForOrg: (orgId: string) => Promise<readonly TeamRow[]>;
  /**
   * Stable role-resolution contract — `resolveOrgRoleForUser(orgId, userId)`
   * (active-org-scoped Better Auth membership role; per-request cached).
   */
  readonly resolveOrgRole: (
    orgId: string,
    userId: string,
  ) => Promise<"org_owner" | "org_admin" | "member" | undefined>;
};

export type TeamVisibilityIdentity = {
  readonly userId?: string | null;
  readonly organizationId?: string | null;
};

function isWideningRole(
  role: string | undefined,
): role is TeamWideningOrgRole {
  return (
    role !== undefined &&
    (TEAM_WIDENING_ORG_ROLES as readonly string[]).includes(role)
  );
}

/**
 * Compute the actor's visible team ids: direct memberships, widened to the
 * whole active org for `org_admin` / `org_owner` actors. See the module
 * docblock for the full policy and failure semantics.
 */
export async function resolveVisibleTeamIds(
  identity: TeamVisibilityIdentity,
  deps: TeamVisibilityDeps,
): Promise<readonly string[]> {
  const userId = identity.userId ?? "";
  const organizationId = identity.organizationId ?? "";
  if (!userId || !organizationId) return [];

  // Direct memberships — failures propagate (caller fails the cube closed).
  const direct = await deps.readTeamsForUser(userId, organizationId);
  const directIds = direct.map((t) => t.id);

  // Role resolution — degrade to direct membership on failure (never wider).
  let role: string | undefined;
  try {
    role = await deps.resolveOrgRole(organizationId, userId);
  } catch {
    return directIds;
  }
  if (!isWideningRole(role)) return directIds;

  // Org-wide widening — degrade to direct membership on failure.
  let orgTeams: readonly TeamRow[];
  try {
    orgTeams = await deps.listTeamsForOrg(organizationId);
  } catch {
    return directIds;
  }
  const union = new Set<string>(directIds);
  for (const t of orgTeams) union.add(t.id);
  return Array.from(union);
}
