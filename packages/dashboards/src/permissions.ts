/**
 * Single permission resolver for the dashboards platform.
 *
 * Used by every read/write surface (list, get, mutation service, MCP, AI).
 * All four code paths import THIS module — verified by integration tests
 * across all four surfaces.
 *
 * Phase-2 ACL cutover (cinatra#1898, epic #1883 §D7; owner ruling 2026-07-20
 * "ruling 5"): a dashboard is ALWAYS visible to everyone in its scope. Access
 * derives PURELY from scope (owner tier + project refinement) — the retired
 * dashboard-local `{private, owners, members}` visibility vocabulary no longer
 * participates in the decision (the `visibility` column is demoted/write-only,
 * dropped in Phase-3 after this resolver soaks). Read = "member of the owning
 * scope" (owner OR member); write = "owner of the owning scope". This mapping is
 * the row projection of the SAME canonical `object.read` filter the library uses
 * — the library/dashboard AGREEMENT is pinned by a property-style conformance
 * test (`library-dashboard-agreement.test.ts`).
 *
 * 4-level ownership doctrine: user / team / organization / workspace.
 *
 * "Owners" (WRITE authority) per owner_level:
 *   - user    → owner_id itself (creator)
 *   - team    → team admins (Better Auth role 'admin' in the owner team)
 *   - org     → org admins/owners (Better Auth role 'admin'|'owner' in the owner org)
 *   - workspace → workspace admins (same Better Auth role lookup, against the
 *                 workspace organization id)
 *
 * "Members" (READ visibility) per owner_level: any member of the owning scope —
 * the user themselves / any team member / any org member / any org member for a
 * workspace row. A project-refined dashboard reads as "any in-scope actor" at the
 * owner tier (canRead true) and is narrowed to project members by the project
 * grant the callers (`requireDashboardAccess` / `filterReadableDashboards`) apply
 * on top — matching the object filter, whose project row is org-owned+private and
 * so admits only via the project clause.
 *
 * Workspace-owned rows are stored at the DB layer like org-owned rows because
 * there is no dedicated `cinatra.workspaces` table. The row shape is kept so
 * workspace ownership can split when the Workspace tier lands.
 */
import type { DashboardRow, OwnerLevel } from "./store/schema";
// Pure OBO scope-ceiling helper (zero-dep subpath — no transport runtime pulled).
import {
  resourceWithinCeiling,
  type OboCeilingChain,
  type CeilingResource,
} from "@cinatra-ai/mcp-server/obo-ceiling";

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
  /**
   * Agent-run OBO scope-ceiling CHAIN — the agent's anchored-scope upper bound.
   * Set ONLY for agent-run OBO delegated actors (threaded from the MCP request
   * frame by the dashboards registry/handler); undefined for every human /
   * session caller. When present, a dashboard row must fall WITHIN the chain or
   * access is denied outright — checked before the owner/member/visibility gates.
   */
  readonly oboCeiling?: OboCeilingChain;
};

export type DashboardAccess = {
  readonly canRead: boolean;
  readonly canWrite: boolean;
};

/**
 * Map a dashboard row onto the shared `CeilingResource` facets consumed by
 * `resourceWithinCeiling`. Dashboards carry a native 4-tier owner axis
 * (`owner_level`/`owner_id`, CHECK-constrained to user/team/organization/
 * workspace) plus an optional `project_id` refinement — a direct mapping.
 */
function dashboardRowToCeilingFacets(row: DashboardRow): CeilingResource {
  return {
    orgId: row.organizationId,
    owner: {
      tier: row.ownerLevel as "user" | "team" | "organization" | "workspace",
      id: row.ownerId,
    },
    projectId: row.projectId ?? null,
  };
}

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
 *
 * Phase-2 (cinatra#1898): scope-only, `visibility`-column-free. Read = owner OR
 * member of the owning scope; write = owner. A project-refined row reads as "any
 * in-scope actor" at the owner tier — the project grant the callers apply narrows
 * it to project members (see the module header). This is the exact row projection
 * of the canonical `object.read` filter over the dashboard's scope tuple.
 */
export function resolveDashboardAccess(
  row: DashboardRow,
  actor: DashboardActor,
): DashboardAccess {
  // OBO scope-ceiling containment — evaluated FIRST, before the cross-org gate
  // and every owner/member short-circuit below, so a delegated agent run cannot
  // read/write a dashboard outside the agent's anchored scope even when the
  // invoking user is the row's owner. Set only for agent-run OBO actors;
  // undefined ⇒ no-op for human/session callers.
  if (
    actor.oboCeiling &&
    !resourceWithinCeiling(dashboardRowToCeilingFacets(row), actor.oboCeiling)
  ) {
    return { canRead: false, canWrite: false };
  }

  // Cross-org check is the first gate — no further evaluation needed.
  if (row.organizationId !== actor.organizationId) {
    return { canRead: false, canWrite: false };
  }

  // Project-refined rows: the object tuple is organization-owned + private +
  // project-refined (deriveDashboardScopeTuple), so the canonical object.read
  // filter admits it ONLY via the project clause. Mirror that here — any in-org
  // actor passes the owner-tier read gate (canRead: true); the project GRANT that
  // `requireDashboardAccess` / `filterReadableDashboards` apply on top is the
  // effective read gate. WRITE stays owner-axis (the project WRITE grant those
  // callers additionally require narrows it). Callers that do NOT apply a project
  // grant (the MCP list/get, listDashboardsForEntity, getEntityDashboard) exclude
  // project rows structurally, so canRead: true here never over-shares.
  //
  // TRUTHINESS (not `!= null`) is load-bearing: every grant/exclusion layer keys
  // on `if (row.projectId)` (filterReadableDashboards, requireDashboardAccess
  // step-2, getEntityDashboard, the MCP `isNull(projectId)` SQL treats '' as a
  // value). A `project_id = ''` row (no non-empty DB constraint) must therefore
  // NOT take this canRead:true branch — else it would skip the grant gate AND
  // never match the object filter's project clause. Treating '' as unscoped keeps
  // this resolver in lockstep with the grant layers and the scope-tuple mapping.
  if (row.projectId) {
    return { canRead: true, canWrite: isOwner(row, actor) };
  }

  // Non-project rows: scope-visible read (owner OR member), owner-only write.
  // (User rows: member === owner, so canRead collapses to "the owning user".)
  const owner = isOwner(row, actor);
  const member = isMember(row, actor);
  return { canRead: owner || member, canWrite: owner };
}
