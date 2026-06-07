/**
 * Single permission resolver for the dashboards platform.
 *
 * Used by every read/write surface (list, get, mutation service, MCP, AI).
 * All four code paths import THIS module — verified by integration tests
 * across all four surfaces.
 *
 * 4-level ownership doctrine: user / team / organization / workspace.
 * Visibility is a separate axis: private / owners / members.
 *
 * "Owners" per owner_level:
 *   - user    → owner_id itself (creator)
 *   - team    → team admins (Better Auth role 'admin' in the owner team)
 *   - org     → org admins/owners (Better Auth role 'admin'|'owner' in the owner org)
 *   - workspace → workspace admins (same Better Auth role lookup, against the
 *                 workspace organization id)
 *
 * Workspace-owned rows are stored at the DB layer like org-owned rows because
 * there is no dedicated `cinatra.workspaces` table. The row shape is kept so
 * workspace ownership can split when the Workspace tier lands.
 */
import type { DashboardRow, OwnerLevel, Visibility } from "./store/schema";

/** Actor envelope. Subset of PrimitiveActorContext to keep this module Cinatra-decoupled. */
export type DashboardActor = {
  readonly userId: string;
  /** The actor's currently-active org. */
  readonly organizationId: string;
  /** Team IDs the actor belongs to (resolved by the MCP/route layer). */
  readonly teamIds: readonly string[];
  /** Better Auth role in the active org: 'owner' | 'admin' | 'member'. */
  readonly orgRole?: "owner" | "admin" | "member";
  /** Team-admin role per team id (only populated when known). */
  readonly teamRoles?: Readonly<Record<string, "admin" | "member">>;
};

export type DashboardAccess = {
  readonly canRead: boolean;
  readonly canWrite: boolean;
};

/** Internal: a row's "owner" check — does the actor have owner-level authority? */
function isOwner(row: DashboardRow, actor: DashboardActor): boolean {
  switch (row.ownerLevel as OwnerLevel) {
    case "user":
      return row.ownerId === actor.userId;
    case "team":
      return actor.teamRoles?.[row.ownerId] === "admin";
    case "organization":
    case "workspace":
      // workspace owners use the same Better Auth role check because
      // ownership currently resolves through the workspace organization id.
      return (
        row.ownerId === actor.organizationId &&
        (actor.orgRole === "admin" || actor.orgRole === "owner")
      );
    default:
      return false;
  }
}

/** Internal: is the actor a "member" of the row's owner entity (non-owner)? */
function isMember(row: DashboardRow, actor: DashboardActor): boolean {
  switch (row.ownerLevel as OwnerLevel) {
    case "user":
      // Only the user themselves; no concept of "members of a user."
      return row.ownerId === actor.userId;
    case "team":
      return actor.teamIds.includes(row.ownerId);
    case "organization":
    case "workspace":
      return row.ownerId === actor.organizationId;
    default:
      return false;
  }
}

/**
 * Compute the access verdict for `actor` against `row`. The result is the
 * same regardless of which surface called (list filter, MCP handler, etc.).
 */
export function resolveDashboardAccess(
  row: DashboardRow,
  actor: DashboardActor,
): DashboardAccess {
  // Cross-org check is the first gate — no further evaluation needed.
  if (row.organizationId !== actor.organizationId) {
    return { canRead: false, canWrite: false };
  }

  const owner = isOwner(row, actor);
  const member = isMember(row, actor);

  // User-owned rows: only the owning user can read/write — visibility ignored.
  if (row.ownerLevel === "user") {
    return { canRead: owner, canWrite: owner };
  }

  // For team/org/workspace, intersect ownership with visibility:
  const visibility = row.visibility as Visibility;
  switch (visibility) {
    case "private":
      // Only owners (per level) can read/write.
      return { canRead: owner, canWrite: owner };
    case "owners":
      // Same as private from the kernel's perspective; semantic distinction
      // is whether other "members" can see it exists (they cannot, in both).
      return { canRead: owner, canWrite: owner };
    case "members":
      // Any member of the owner entity can read; only owners write.
      return { canRead: owner || member, canWrite: owner };
    default:
      // Unknown visibility — fail closed.
      return { canRead: false, canWrite: false };
  }
}
