import "server-only";

// ---------------------------------------------------------------------------
// Server-side install-scope picker context builder — SHARED by the agent
// registry detail screen (packages/agents/src/screens.tsx) and the extension
// marketplace screen (packages/extensions/src/screens/
// extensions-marketplace-screen.tsx).
//
// Single source of truth for the picker rows (enabled/disabled state per
// target) + the value→display-name lookup. The dialogs never read
// actor.teamRoles — they consume `installTargets` as a pre-decided shape.
// The row grid mirrors the assertCanInstallAtTarget rules in
// ./install-target-authz.ts (parity locked by
// src/__tests__/install-targets-parity.test.ts).
//
// NOTE: Production today does NOT load teamRoles from any canonical store
// (Better Auth's teamMember table has no role column). Team and
// team-owned-project rows are DISABLED for non-platform_admin actors until
// team_admin role loading exists. The picker reflects this naturally — no
// special branch here.
//
// Project visibility is intentionally narrower than "all projects in the
// org": only projects owned by the actor (user-owned) or owned by a team the
// actor is a member of are listed — non-owners should not see projects they
// have no install authority over. (A project where the actor is only a
// co-owner of another user's project is not listed today; the server-side
// gate would allow it — pre-existing picker limitation, kept for parity.)
// ---------------------------------------------------------------------------

import {
  buildInstallTargets,
  pickDefaultPickerValue,
  type InstallActorForTargets,
  type InstallTarget,
} from "./install-targets";
import {
  readTeamsForUser,
  betterAuthDb,
  betterAuthOrganizations,
} from "@/lib/better-auth-db";
import {
  readProjectCoOwners,
  projects as projectsTable,
  projectsDb,
} from "@/lib/projects-store";
import { and, eq, inArray, or } from "drizzle-orm";

export type InstallTargetPickerContext = {
  /** SERVER-COMPUTED rows — single source of truth for enabled/disabled state. */
  installTargets: InstallTarget[];
  /** value → display name lookup (e.g. "team:abc" → "Engineering"). */
  ownerEntityNames: Record<string, string>;
  /**
   * Default picker selection per pickDefaultPickerValue (current project →
   * first enabled team → org → null). Callers wanting a different default
   * (e.g. the marketplace's org-first one-click default) derive it from
   * `installTargets` instead.
   */
  defaultValue: string | null;
};

type SessionForPicker = {
  user: { id: string; role?: string | null };
  session?: { activeOrganizationId?: string | null } | null;
};

/**
 * Compute the install-scope picker rows for a session. Moved VERBATIM from
 * the inline block in screens.tsx so the extension marketplace screen shares
 * one implementation.
 */
export async function buildInstallTargetPickerContext(args: {
  session: SessionForPicker;
  orgRole: "org_owner" | "org_admin" | "member" | undefined;
  currentProjectId?: string;
  /**
   * cinatra#1527: append the always-offered "Whole Workspace" / "Admins only"
   * scopes. Passed `true` by the extension marketplace picker; left off (the
   * default) by the agent at-scope picker, whose install path persists an owner
   * level rather than an audience policy and so cannot target these scopes.
   */
  includeWorkspaceScopes?: boolean;
}): Promise<InstallTargetPickerContext> {
  const { session, orgRole, currentProjectId, includeWorkspaceScopes } = args;
  const activeOrgId = session.session?.activeOrganizationId ?? undefined;

  const installActor: InstallActorForTargets = {
    principalId: session.user.id,
    organizationId: activeOrgId ?? "",
    platformRole:
      String(session.user.role ?? "")
        .split(",")
        .map((s) => s.trim())
        .some((r) => r === "admin" || r === "platform_admin")
        ? "platform_admin"
        : "member",
    orgRole,
    // teamRoles intentionally omitted — see module header.
  };

  // Look up org name for the picker label. Left EMPTY when the org has no name
  // (or no active org): the AccessCombobox owns the single generic fallback
  // ("Your organization"), so no hardcoded "Organization" string is stored in
  // ownerEntityNames — it would otherwise render verbatim for a nameless org
  // (cinatra#1526). buildInstallTargets' org-row label carries its own
  // "this organization" fallback for the empty case.
  let orgName = "";
  if (activeOrgId) {
    const orgRows = await betterAuthDb
      .select({ name: betterAuthOrganizations.name })
      .from(betterAuthOrganizations)
      .where(eq(betterAuthOrganizations.id, activeOrgId))
      .limit(1);
    if (orgRows[0]?.name) orgName = orgRows[0].name;
  }

  // Teams the actor belongs to in the active org.
  const userTeams = activeOrgId
    ? await readTeamsForUser(session.user.id, activeOrgId)
    : [];

  // Projects in the active org owned by the actor (user-owned or co-owned)
  // OR by a team the actor is a member of.
  const projectsForPicker: {
    id: string;
    name: string;
    ownerUserIds: string[];
    owningTeamId: string | null;
  }[] = [];
  if (activeOrgId) {
    const teamIds = userTeams.map((t) => t.id);
    const ownClause = and(
      eq(projectsTable.ownerLevel, "user"),
      eq(projectsTable.ownerId, session.user.id),
    );
    const teamClause =
      teamIds.length > 0
        ? and(
            eq(projectsTable.ownerLevel, "team"),
            inArray(projectsTable.ownerId, teamIds),
          )
        : undefined;
    const orClauses = [ownClause, ...(teamClause ? [teamClause] : [])];
    // ACTIVE-ORG constraint on the whole query — without it a user-owned
    // project from ANOTHER org would surface (and leak its name) in the
    // picker. The server authz gate would still deny the cross-org target
    // (assertTargetBelongsToActiveOrg), but the rows must not render at all.
    const rows = await projectsDb
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        ownerLevel: projectsTable.ownerLevel,
        ownerId: projectsTable.ownerId,
      })
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.organizationId, activeOrgId),
          orClauses.length > 1 ? or(...orClauses) : ownClause,
        ),
      )
      .orderBy(projectsTable.name);

    for (const row of rows) {
      // ownerUserIds union: project owner (when user-owned) + co-owners.
      const ownerUserIds: string[] = [];
      if (row.ownerLevel === "user") ownerUserIds.push(row.ownerId);
      const coOwners = await readProjectCoOwners(row.id);
      for (const co of coOwners) ownerUserIds.push(co.userId);
      projectsForPicker.push({
        id: row.id,
        name: row.name,
        ownerUserIds,
        owningTeamId: row.ownerLevel === "team" ? row.ownerId : null,
      });
    }
  }

  const installTargets = buildInstallTargets({
    actor: installActor,
    activeOrgId: activeOrgId ?? "",
    orgName,
    teams: userTeams,
    projects: projectsForPicker,
    currentProjectId,
    includeWorkspaceScopes,
  });
  const ownerEntityNames: Record<string, string> = {
    // Multi-scope W1: key the org label on the id-carrying token (matches the
    // install-target row value `org:<activeOrgId>`); the bare "org" key retired.
    [`org:${activeOrgId ?? ""}`]: orgName,
    ...Object.fromEntries(userTeams.map((t) => [`team:${t.id}`, t.name])),
    ...Object.fromEntries(
      projectsForPicker.map((p) => [`project:${p.id}`, p.name]),
    ),
  };
  const defaultValue = pickDefaultPickerValue(installTargets, currentProjectId);

  return { installTargets, ownerEntityNames, defaultValue };
}
