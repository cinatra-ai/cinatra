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

export type InstallTargetLevel =
  | "organization"
  | "team"
  | "project"
  | "workspace"
  | "admin";

export type InstallTarget = {
  /** Picker value: "org:<id>" | "team:<id>" | "project:<id>" (multi-scope W1
   * retired the bare "org" token; the org row now carries "org:<activeOrgId>"
   * so labels / adapters / ownerEntityNames unify on the id-carrying form).
   * The always-offered workspace scopes (cinatra#1527) carry the bare tokens
   * "workspace" / "admin" — matching the AccessCombobox labels and the audience
   * visibility tokens. */
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
  /**
   * cinatra#1527: append the two always-offered workspace scopes — "Whole
   * Workspace" and "Admins only". OFF by default so the shared agent
   * at-scope picker (which cannot install to a workspace-audience scope — its
   * install persists an owner level, not an audience) is unaffected. The
   * extension marketplace picker passes `true`. Both rows are platform-admin-
   * only (mirrors assertCanInstallAtTarget); non-admins see them DISABLED with
   * a reason.
   */
  includeWorkspaceScopes?: boolean;
};

const REASON_ORG = "Requires organization admin role.";
const REASON_NO_ACTIVE_ORG = "Requires an active organization.";
const REASON_TEAM = "Requires team admin role on this team.";
const REASON_PROJECT =
  "Requires project ownership or team admin of the owning team.";
const REASON_WORKSPACE_SCOPE = "Requires platform admin.";

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
    // cinatra#2372 AC2: an empty/whitespace activeOrgId is the production
    // no-active-organization shape (`activeOrgId ?? ""`). The org row then
    // carries the degenerate empty-tail `org:` token — display-only, NEVER
    // enabled, regardless of role: a platform admin must not get an enabled
    // row whose submit the server action can only reject.
    const hasActiveOrg = activeOrgId.trim().length > 0;
    const enabled = hasActiveOrg && (isPlatformAdmin || isOrgAdminOrOwner);
    rows.push({
      // Multi-scope W1: id-carrying org token (retired the bare "org").
      // `label` is DEAD for rendering (cinatra#2372 — see the workspace/admin
      // rows below); kept in the current vocabulary rather than the retired
      // "Anyone in <org>" copy.
      value: `org:${activeOrgId}`,
      label: `Organization: ${orgName || "this organization"}`,
      level: "organization",
      id: activeOrgId,
      disabled: !enabled,
      reason: enabled ? undefined : hasActiveOrg ? REASON_ORG : REASON_NO_ACTIVE_ORG,
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

  // ---------------------------------------------------------------------------
  // Workspace scopes (cinatra#1527) — ALWAYS offered when requested, both
  // platform-admin-only (mirrors assertCanInstallAtTarget's workspace/admin
  // branch). The id is the active org, the canonical tenant/workspace anchor;
  // the install action re-derives it server-side and never trusts a client id.
  // ---------------------------------------------------------------------------
  if (args.includeWorkspaceScopes) {
    // `label` is DEAD for rendering (cinatra#2372): the flat AccessCombobox
    // single mode derives every row's text from the canonical flat-option
    // model (src/components/access-scope.ts), never from this field — only
    // ownerEntityNames (org/team/project) feeds it. Kept in the audience's
    // OWN canonical vocabulary rather than the retired "Whole Workspace" /
    // bare "Admins only" copy, so nothing that reads this field in the future
    // (a log line, a debug view) resurfaces stale audience copy.
    rows.push({
      value: "workspace",
      label: "Workspace: All",
      level: "workspace",
      id: activeOrgId,
      disabled: !isPlatformAdmin,
      reason: isPlatformAdmin ? undefined : REASON_WORKSPACE_SCOPE,
    });
    rows.push({
      value: "admin",
      label: "Workspace: Admins only",
      level: "admin",
      id: activeOrgId,
      disabled: !isPlatformAdmin,
      reason: isPlatformAdmin ? undefined : REASON_WORKSPACE_SCOPE,
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
  // The degenerate no-active-org row (empty-tail `org:` token) is never a
  // default: buildInstallTargets already disables it, and the explicit
  // empty-id guard here keeps the invariant even if the two functions are
  // ever fed rows built elsewhere (cinatra#2372 AC2 — the defaulted `org:`
  // value is exactly how the enabled-but-rejected submit became reachable).
  const orgRow = targets.find((t) => t.level === "organization" && !t.disabled);
  if (orgRow && !orgRow.disabled && orgRow.id.trim().length > 0) return orgRow.value;
  return null;
}
