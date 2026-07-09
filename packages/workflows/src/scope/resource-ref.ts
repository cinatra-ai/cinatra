import type { OwnershipLevel } from "../spec/types";

// Scope scaffold. The release-workflows package stays a
// leaf: it defines the resource-ref shape + read-visibility filter + a
// project-archive gate hook, but the concrete authz/archive functions are
// INJECTED by the host MCP-handler layer so we never import @/lib here.

export type WorkflowResourceRef = {
  level: OwnershipLevel | "project" | undefined;
  ownerId: string | null;
  organizationId: string | null;
  projectId: string | null;
};

// Minimal row shape carrying ownership/tenant columns (workflow or template).
export type ScopedRow = {
  orgId: string;
  ownerLevel?: string | null;
  ownerId?: string | null;
  projectId?: string | null;
};

// The auth-derived actor. `organizationId` MUST come from the session
// (session.activeOrganizationId) / auth header — NEVER a request-body id
// (cross-tenant safety).
export type WorkflowActor = {
  organizationId: string | null;
  userId?: string | null;
  teamIds?: readonly string[];
  /** Project ids the actor has read access to (project_access grants). Required
   *  for project-scoped rows to be visible — see isReadable. */
  projectIds?: readonly string[];
  /** Better Auth org role — gates manage on org/workspace-owned rows. */
  orgRole?: string | null;
  platformRole?: string | null;
};

/**
 * ADMIN STANDING (P3) over a workflow/template row whose org the caller has
 * ALREADY confirmed matches the actor's active org. An org_owner/org_admin holds
 * admin standing over every workflow/template of their org — the mirror of the
 * P1 evaluator's `hasAdminStandingOverExtension` (org-anchored branch). Callers
 * MUST gate on the org match before consulting this (it is role-only); the
 * cross-org boundary stays enforced by that preceding guard.
 */
function isOrgAdminOfMatchedOrg(actor: WorkflowActor): boolean {
  return actor.orgRole === "org_admin" || actor.orgRole === "org_owner";
}

export function buildWorkflowResourceRef(row: ScopedRow): WorkflowResourceRef {
  return {
    level: (row.ownerLevel as WorkflowResourceRef["level"]) ?? undefined,
    ownerId: row.ownerId ?? null,
    organizationId: row.orgId ?? null,
    projectId: row.projectId ?? null,
  };
}

/**
 * Read-visibility. The tenant boundary is the actor's auth-derived
 * `organizationId`: a row is never visible across orgs. Within the org,
 * ownership level decides visibility. Project-scoped rows additionally require a
 * project-access grant — layered by the handler on top of this base filter.
 */
export function isReadable(row: ScopedRow, actor: WorkflowActor): boolean {
  if (actor.platformRole === "platform_admin") return true;
  if (!actor.organizationId || row.orgId !== actor.organizationId) return false;
  // ADMIN STANDING (P3): an org_owner/org_admin of the row's org reads every
  // workflow/template of that org — INCLUDING project sealed-room, team, and
  // user-owned rows — so admin catalog/list/detail parity does not depend on the
  // acting admin's personal project/team/user ownership. The org boundary is
  // already enforced by the guard above, so this is cross-org safe. Confined to
  // workflow/template ScopedRow; linked run/artifact content stays separately gated.
  if (isOrgAdminOfMatchedOrg(actor)) return true;
  // Project-scoped rows (sealed-room) are visible ONLY to actors with a
  // project-access grant — fail-closed, independent of ownership level. The
  // caller must populate actor.projectIds from project_access.
  if (row.projectId) return Boolean(actor.projectIds?.includes(row.projectId));
  switch (row.ownerLevel) {
    case "workspace":
    case "organization":
      return true; // visible to all members of the (matching) org
    case "team":
      return Boolean(row.ownerId && actor.teamIds?.includes(row.ownerId));
    case "user":
      return Boolean(row.ownerId && actor.userId && row.ownerId === actor.userId);
    default:
      // Unset ownership defaults to org-scoped visibility (org already matched).
      return true;
  }
}

export function filterReadable<T extends ScopedRow>(rows: readonly T[], actor: WorkflowActor): T[] {
  return rows.filter((r) => isReadable(r, actor));
}

/**
 * Manage (mutate) authorization for a workflow/template row — the leaf-package
 * equivalent of requireResourceAccess(..., "manage"). Project-scoped rows need a
 * project grant; user-owned → owner only; team-owned → team member; org/workspace
 * → org_admin/org_owner. platform_admin bypasses. Read-visibility (isReadable) is
 * a precondition the caller should also enforce.
 */
export function canManage(row: ScopedRow, actor: WorkflowActor): boolean {
  if (actor.platformRole === "platform_admin") return true;
  if (!actor.organizationId || row.orgId !== actor.organizationId) return false;
  // ADMIN STANDING (P3): an org_owner/org_admin manages every workflow/template
  // of their org regardless of project/team/user ownership — manage parity stops
  // depending on the acting admin's personal ownership. Placed BEFORE the
  // project-grant gate so a sealed-room row is manageable by an owning-org admin.
  // Org already matched above ⇒ cross-org safe. (Also subsumes the org/workspace
  // admin branches in the switch below, which stay correct for non-admins.)
  if (isOrgAdminOfMatchedOrg(actor)) return true;
  if (row.projectId && !actor.projectIds?.includes(row.projectId)) return false;
  switch (row.ownerLevel) {
    case "user":
      return Boolean(row.ownerId && actor.userId && row.ownerId === actor.userId);
    case "team":
      return Boolean(row.ownerId && actor.teamIds?.includes(row.ownerId));
    case "organization":
    case "workspace":
      return actor.orgRole === "org_admin" || actor.orgRole === "org_owner";
    default:
      // Unset ownership — manage requires org admin (fail-closed).
      return actor.orgRole === "org_admin" || actor.orgRole === "org_owner";
  }
}

// Project archive/write gate. Injected to keep the package a
// leaf: the host passes its `assertProjectWritable` (src/lib/project-writable.ts).
export type AssertProjectWritable = (projectId: string) => void | Promise<void>;

export async function assertWorkflowProjectWritable(
  deps: { assertProjectWritable: AssertProjectWritable },
  row: ScopedRow,
): Promise<void> {
  if (row.projectId) await deps.assertProjectWritable(row.projectId);
}
