import "server-only";

/**
 * Server-side helper that computes the picker rows for the InstallScopeDialog.
 * The disabled/enabled state per row mirrors the `assertCanInstallAtTarget`
 * rules from packages/agents/src/actions.ts. The two implementations MUST
 * agree, with src/__tests__/install-targets-parity.test.ts enforcing parity.
 *
 * Why duplicate instead of import?
 *   - assertCanInstallAtTarget is not currently exported from actions.ts.
 *   - It throws AuthzError on deny (with a side-effecting audit hook in the
 *     real call path); the picker just needs a boolean per row.
 *   - Replicating the rule grid here keeps the helper a leaf module with no
 *     server-action transitive deps and makes the parity contract explicit
 *     via the unit test grid.
 *
 * Rules (must match assertCanInstallAtTarget):
 *  - org:           platform_admin OR org_admin OR org_owner
 *  - team:<id>:     platform_admin OR actor.teamRoles[id] === "team_admin"
 *  - project:<id>:  platform_admin OR actor in project.ownerUserIds OR
 *                   actor.teamRoles[project.owningTeamId] === "team_admin"
 *
 * NOTE: Production today does NOT load `actor.teamRoles` from any canonical
 * store (Better Auth's teamMember table has no role column). Team-target
 * installs by non-platform_admin actors are disabled by default unless
 * team_admin role loading supplies those roles. The picker's disabled state
 * reflects this naturally, with no special-case branch needed here.
 */

export type InstallTargetLevel = "organization" | "team" | "project";

export type InstallTarget = {
  /** Picker value: "org" | "team:<id>" | "project:<id>" */
  value: string;
  label: string;
  level: InstallTargetLevel;
  /** Canonical id at the chosen level (org id, team id, project id). */
  id: string;
  disabled: boolean;
  /** Tooltip text when disabled. Always present when disabled is true. */
  reason?: string;
};

export type InstallActorForTargets = {
  principalId: string;
  organizationId: string;
  platformRole?: "platform_admin" | "member";
  orgRole?: "org_owner" | "org_admin" | "member";
  teamRoles?: Record<string, "team_admin" | "member">;
};

export type BuildInstallTargetsArgs = {
  actor: InstallActorForTargets;
  activeOrgId: string;
  orgName: string;
  /** Teams the actor is a member of (already filtered to the active org). */
  teams: { id: string; name: string }[];
  /**
   * Projects in the active org that are visible to the actor. ownerUserIds
   * carries the project owner + co-owners (owner_level === "user" union
   * project_co_owners). owningTeamId is project.owner_id when
   * project.owner_level === "team", otherwise null.
   */
  projects: {
    id: string;
    name: string;
    ownerUserIds: string[];
    owningTeamId: string | null;
  }[];
  currentProjectId?: string;
};

const REASON_ORG = "Requires organization admin role.";
const REASON_TEAM = "Requires team admin role on this team.";
const REASON_PROJECT =
  "Requires project ownership or team admin of the owning team.";

export function buildInstallTargets(
  args: BuildInstallTargetsArgs,
): InstallTarget[] {
  const { actor, activeOrgId, orgName, teams, projects } = args;
  const isPlatformAdmin = actor.platformRole === "platform_admin";
  const isOrgAdminOrOwner =
    actor.orgRole === "org_admin" || actor.orgRole === "org_owner";

  const rows: InstallTarget[] = [];

  // ---------------------------------------------------------------------------
  // Org row.
  // ---------------------------------------------------------------------------
  {
    const enabled = isPlatformAdmin || isOrgAdminOrOwner;
    rows.push({
      value: "org",
      label: `Anyone in ${orgName || "this organization"}`,
      level: "organization",
      id: activeOrgId,
      disabled: !enabled,
      reason: enabled ? undefined : REASON_ORG,
    });
  }

  // ---------------------------------------------------------------------------
  // Team rows.
  // ---------------------------------------------------------------------------
  for (const team of teams) {
    const enabled =
      isPlatformAdmin || actor.teamRoles?.[team.id] === "team_admin";
    rows.push({
      value: `team:${team.id}`,
      label: team.name,
      level: "team",
      id: team.id,
      disabled: !enabled,
      reason: enabled ? undefined : REASON_TEAM,
    });
  }

  // ---------------------------------------------------------------------------
  // Project rows.
  // ---------------------------------------------------------------------------
  for (const project of projects) {
    const isOwner = project.ownerUserIds.includes(actor.principalId);
    const isTeamAdminOfOwningTeam =
      project.owningTeamId != null &&
      actor.teamRoles?.[project.owningTeamId] === "team_admin";
    const enabled = isPlatformAdmin || isOwner || isTeamAdminOfOwningTeam;
    rows.push({
      value: `project:${project.id}`,
      label: project.name,
      level: "project",
      id: project.id,
      disabled: !enabled,
      reason: enabled ? undefined : REASON_PROJECT,
    });
  }

  return rows;
}

/**
 * Choose the default picker selection from a computed `InstallTarget[]`.
 * Default selection order:
 *   1. If `currentProjectId` is in scope and that project row is enabled,
 *      default to it.
 *   2. Otherwise, the first enabled team row.
 *   3. Otherwise, the org row (if enabled).
 *   4. Otherwise, null (no installable scope, so the caller renders the empty
 *      state instead of the picker).
 */
export function pickDefaultPickerValue(
  targets: InstallTarget[],
  currentProjectId: string | undefined,
): string | null {
  if (currentProjectId) {
    const projectRow = targets.find(
      (t) => t.value === `project:${currentProjectId}`,
    );
    if (projectRow && !projectRow.disabled) return projectRow.value;
  }
  const enabledTeam = targets.find((t) => t.level === "team" && !t.disabled);
  if (enabledTeam) return enabledTeam.value;
  const orgRow = targets.find((t) => t.level === "organization" && !t.disabled);
  if (orgRow && !orgRow.disabled) return orgRow.value;
  return null;
}
