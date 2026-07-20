import "server-only";

import { resolveOrgRoleForUser, type AuthzOrgRole } from "@/lib/auth-session";
import { roleHasPermission } from "@/lib/authz/policies";

/**
 * Shared VIEWED-org management gate for `/organizations/[id]` (cinatra#1510).
 *
 * The org-detail surface is unique: its `id` is an organization that may
 * differ from the viewer's ACTIVE organization (a multi-org member opening a
 * non-active org from the list). `canDo()` is ACTIVE-org scoped and fails
 * closed cross-org (src/lib/authz/enforce.ts), so it is the WRONG primitive
 * here. The correct viewed-org identity primitive is
 * `resolveOrgRoleForUser(orgId, userId)` — the per-request-cached membership
 * lookup that returns the caller's role IN THAT org (`org_owner | org_admin |
 * member`) or `undefined` for a non-member.
 *
 * That role is then mapped through the REAL permission catalog
 * (src/lib/authz/policies.ts) so the affordances ship exactly "where
 * permitted" (the owner ruling's own fence):
 *
 *   - `organization.update`        → org_admin+  (rename name, edit slug)
 *   - `organization.manageMembers` → org_owner   (member role/remove, invites)
 *   - member                       → read-only    (no management)
 *
 * INVARIANT (codex convergence, 1510-codex2): the resolved role is NOT blanket
 * authorization. There is deliberately NO `platform_admin` synthesis here — a
 * platform admin who is not a member of THIS org resolves to `undefined` and
 * gets no management, exactly like any other non-member. Organization CRUD is
 * granted only by the viewed-org membership role mapped through the catalog.
 *
 * This module is the single source of truth so the page-render gate, the UI
 * affordance gate, and the server-action write gate cannot drift (the #1536
 * shared-gate pattern).
 */

/**
 * Structural subset of the Better Auth session this gate reads — kept in
 * lockstep with `resolveOrgRoleForUser`'s inputs. The active-org id is
 * deliberately unused (the gate is viewed-org scoped); only `user.id` matters.
 */
type SessionLike = {
  user: { id: string };
  session?: { activeOrganizationId?: string | null } | null;
};

export type OrganizationManageCapabilities = {
  /** The caller's role in the VIEWED org, or `undefined` for a non-member. */
  readonly role: AuthzOrgRole | undefined;
  /** `organization.update` — org_admin+; rename name + edit slug. */
  readonly canManageSettings: boolean;
  /** `organization.manageMembers` — org_owner; member role/remove + invites. */
  readonly canManageMembers: boolean;
};

const NO_CAPABILITIES: OrganizationManageCapabilities = {
  role: undefined,
  canManageSettings: false,
  canManageMembers: false,
};

/**
 * Resolve the viewed-org management capabilities for a session. Fail-closed:
 * a missing session/user, a missing org id, an unresolvable role (non-member),
 * or any lookup error yields NO capabilities.
 */
export async function resolveOrganizationManageCapabilities(
  session: SessionLike | null | undefined,
  organizationId: string,
): Promise<OrganizationManageCapabilities> {
  const userId = session?.user?.id;
  if (!userId || !organizationId) return NO_CAPABILITIES;

  const role = await resolveOrgRoleForUser(organizationId, userId).catch(
    () => undefined,
  );
  if (!role) return NO_CAPABILITIES;

  return {
    role,
    canManageSettings: roleHasPermission(role, "organization.update"),
    canManageMembers: roleHasPermission(role, "organization.manageMembers"),
  };
}

/**
 * Viewed-org gate for organization SETTINGS (rename name, edit slug):
 * `organization.update`, held by org_admin and above. Fail-closed.
 */
export async function userCanManageOrganization(
  session: SessionLike | null | undefined,
  organizationId: string,
): Promise<boolean> {
  return (await resolveOrganizationManageCapabilities(session, organizationId))
    .canManageSettings;
}

/**
 * Viewed-org gate for MEMBER management (role change/remove, invitations):
 * `organization.manageMembers`, held by org_owner only. Fail-closed.
 */
export async function userCanManageOrganizationMembers(
  session: SessionLike | null | undefined,
  organizationId: string,
): Promise<boolean> {
  return (await resolveOrganizationManageCapabilities(session, organizationId))
    .canManageMembers;
}
