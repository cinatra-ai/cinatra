/**
 * The canonical dashboard SCOPE-TUPLE mapping (epic #1883 §D7 ACL cutover,
 * cinatra#1898; product decision 2026-07-20 "ruling 5"). Introduced by Phase-2;
 * with Phase-3 (migration core__0087) the demoted `dashboards.visibility` column
 * is GONE, so this mapping is the ONLY place a dashboard's share axis is
 * decided.
 *
 * PURE — no session, no I/O, no server-only deps — so BOTH the server-only twin
 * writer (`dashboard-artifact-twin-writer.ts`, which stamps the paired `objects`
 * row) AND the host-side library/dashboard AGREEMENT conformance test import it
 * without pulling a database or `server-only`.
 *
 * A dashboard's ACL is derived PURELY from its scope (owner tier + project
 * refinement) — the dashboard-local `{private, owners, members}` visibility
 * vocabulary is retired and its column dropped. Every dashboard maps onto the
 * canonical `objects` ownership columns (owner_level / owner_id / visibility /
 * project_id — see `derived-store-ownership.ts`), so the single canonical
 * `object.read` filter is the ONE gate the library and every /dashboards surface
 * share (Phase-2 replaced the Phase-1 dual authorization with this mapping).
 *
 * The mapping (owner ruling 5 / issue #1898):
 *   - personal (user) → user-owned, private
 *   - team            → team-owned, team-visible
 *   - organization    → organization-owned, organization-visible
 *   - workspace       → workspace-owned, org-local PUBLIC
 *   - project         → ORGANIZATION-owned, private, project-REFINED
 *
 * Why a project dashboard is ORGANIZATION-owned (not its underlying owner tier):
 * the canonical object.read filter's user/team owner clauses are
 * visibility-INDEPENDENT (they admit on owner_level+owner_id alone, without any
 * project grant). A project dashboard must be readable ONLY by project members,
 * so its object tuple must carry NO user/team owner clause — organization-owned +
 * private means the filter admits it EXCLUSIVELY via the project clause
 * (project_id in the actor's granted projects). This is what lets the resolver
 * drop the dashboard-local owner-axis gate for project rows and still agree with
 * the object filter row-for-row.
 */

/** The canonical `objects.visibility` share axis (mirrors CANONICAL_VISIBILITIES
 *  in `derived-store-ownership.ts`). */
export type DashboardObjectVisibility =
  | "private"
  | "team"
  | "organization"
  | "public";

/** The scope inputs the mapping reads off a dashboards row. */
export type DashboardScopeInput = {
  readonly ownerLevel: string;
  readonly ownerId: string;
  readonly organizationId: string;
  readonly projectId: string | null;
};

/** The canonical `objects` ownership tuple a dashboard maps onto. `orgId` is not
 *  part of the tuple here — it is always the dashboard's `organizationId`, set by
 *  the twin/caller alongside this tuple. */
export type DashboardScopeTuple = {
  readonly ownerLevel: string;
  readonly ownerId: string;
  readonly visibility: DashboardObjectVisibility;
  readonly projectId: string | null;
};

/**
 * Map a dashboard's scope onto its canonical `objects` ownership tuple. PURE.
 * See the module header for the mapping and the project-refinement rationale.
 */
export function deriveDashboardScopeTuple(
  input: DashboardScopeInput,
): DashboardScopeTuple {
  // Project-refined → organization-owned, private, project-refined. The object
  // tuple carries NO user/team owner clause, so the canonical object.read filter
  // admits it ONLY via the project clause (project membership is the read gate).
  // TRUTHINESS (not `!= null`) keeps this in lockstep with `resolveDashboardAccess`
  // and every grant layer, which all key on `if (projectId)`: a `project_id = ''`
  // anomaly is treated as UNSCOPED (owner-tier), never as a project row that would
  // then be invisible to the project clause AND skip the grant gate.
  if (input.projectId) {
    return {
      ownerLevel: "organization",
      ownerId: input.organizationId,
      visibility: "private",
      projectId: input.projectId,
    };
  }
  switch (input.ownerLevel) {
    case "user":
      return {
        ownerLevel: "user",
        ownerId: input.ownerId,
        visibility: "private",
        projectId: null,
      };
    case "team":
      return {
        ownerLevel: "team",
        ownerId: input.ownerId,
        visibility: "team",
        projectId: null,
      };
    case "organization":
      return {
        ownerLevel: "organization",
        ownerId: input.ownerId,
        visibility: "organization",
        projectId: null,
      };
    case "workspace":
      // Org-local public: everyone in the owning org may read (multi-tenant
      // fail-closed — the canonical `public` clause is org-scoped for non-admins).
      return {
        ownerLevel: "workspace",
        ownerId: input.ownerId,
        visibility: "public",
        projectId: null,
      };
    default:
      // Unknown tier → fail closed: private + the unknown owner_level means no
      // canonical clause admits the row (only the owning user/team would, and the
      // level is neither), so nobody but a same-tuple owner sees it.
      return {
        ownerLevel: input.ownerLevel,
        ownerId: input.ownerId,
        visibility: "private",
        projectId: null,
      };
  }
}
