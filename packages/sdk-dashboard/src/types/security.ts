/**
 * Ownership levels are user, team, organization, and workspace.
 * Project is NOT an ownership level - it is a bounded execution space whose ownership
 * lives at one of these four levels. Dashboard ownership uses exactly this enum.
 */
export type OwnerLevel = "user" | "team" | "organization" | "workspace";

/**
 * Cinatra's typed SecurityContext. The drizzle-cube adapter internally widens this to
 * drizzle-cube/server's `{ [key: string]: unknown }` shape; consumers of sdk-dashboard
 * only ever see this Cinatra DTO.
 *
 * `accessibleOrgIds` lists every organization the user is a member of
 * (including the active `organizationId`). Cube SQL predicates use this for
 * multi-org row visibility: a user who belongs to multiple orgs sees runs across
 * all of them, not just the active org. Always non-empty; minimum value is
 * `[organizationId]` when no membership query has been run.
 */
export type SecurityContext = {
  readonly userId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly teamIds: readonly string[];
  readonly ownerLevel: OwnerLevel;
  readonly accessibleOrgIds: readonly string[];
  /**
   * Pre-computed visibility-id lists used by the projects / teams /
   * artifacts cubes to filter rows at the SQL predicate layer via
   * `WHERE id IN (...)`. The host computes these via the existing scope
   * helpers (`actor.projectGrants`, `readTeamsForUser`, `listArtifacts`)
   * BEFORE query execution so each cube's `buildSql` stays synchronous and
   * never re-implements sealed-room / project_access / ownership-tier
   * authz inside the cube.
   *
   * Optional because the agent_runs cube + legacy MCP cube paths don't
   * read them. Cubes that DO read these fields fail closed when the list
   * is undefined or empty — no rows visible, never widened.
   */
  readonly visibleProjectIds?: readonly string[];
  readonly visibleTeamIds?: readonly string[];
  readonly visibleArtifactIds?: readonly string[];
  /**
   * Whether the caller is a platform admin. The `llm_usage` cube reads this
   * as its SOLE visibility gate: `usage_events` carries no per-org owner
   * column, so cost/usage data is platform-wide operational data visible
   * only to platform admins. The cube fails closed (zero rows) whenever the
   * flag is missing or not exactly `true`.
   *
   * The host decorates the SecurityContext with this flag at every
   * transport boundary: the HTTP cubejs route via `isPlatformAdmin(session)`
   * and the MCP cube tools via a DB role lookup keyed on the actor's userId
   * (the MCP identity chain carries only userId/orgId, never a role).
   * Optional because cubes other than `llm_usage` never read it.
   */
  readonly isPlatformAdmin?: boolean;
};
