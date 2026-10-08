"use server";
/**
 * Guarded team-detail dashboard actions (cinatra#704, codex convergence;
 * re-tenanted by cinatra#3787).
 *
 * The generic entity-dashboard actions (`actions.ts`) confine every mutation by
 * the bound ref, but for the per-INSTANCE entity types (team/org/project) they
 * do NOT verify that the actor may VIEW the bound entity. On the
 * personal/index surfaces `entityId` IS the active org, so no gap exists; on a
 * team detail page `entityId` is a team id, so a bound action replayed after the
 * caller lost access could read or write a team the caller no longer reaches.
 *
 * These thin `"use server"` wrappers bind ONLY the server-derived `teamId` and,
 * on EVERY invocation, re-authorize from the LIVE session before delegating:
 *   1. re-derive the owner axis from the session (`ownerId = session user`,
 *      never a client-supplied owner);
 *   2. read the team BY ID and take its organization from the row, which is
 *      the tenant of everything below; and
 *   3. confirm the caller may VIEW the team (member OR manager) against THAT
 *      organization, the same gate the screen and `/teams/[teamId]/settings`
 *      apply (`resolveTeamSurfaceAccess`).
 *
 * THE TENANT IS THE TEAM'S ORGANIZATION (cinatra#3787), not the session's active
 * one. The guard used to read the team `WHERE id = … AND organizationId =
 * <active org>`, because the delegate derived its tenant from the session, so a
 * team outside the active organization had to be refused to keep its rows
 * tenant-consistent. The ref now names the team's organization and the delegate
 * honours it, so the replay hazard is closed the other way round and more
 * tightly: an action replayed after an organization switch files under the
 * TEAM's organization, which is the same tenant it filed under before the
 * switch. The refusal is therefore about authority alone, and it says so.
 *
 * WHAT BINDS THESE TODAY: nothing. The team landing mounts the scope dashboards
 * collection panel (`ScopeDashboardsSection`), which carries its own scope and
 * its own write gate, so these wrappers are the guarded path for any surface
 * that binds the generic entity-dashboard actions for a team, and the place the
 * team's tenant rule is written down. The generic actions have their own floor
 * for a ref that arrives from anywhere else (`requireEntityDashboardActor`: a
 * named organization reaches only the session user's own rows, and only where
 * the session holds a role in it).
 */
import { sql } from "drizzle-orm";

import {
  isPlatformAdmin,
  requireAuthSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import { betterAuthDb, teamMemberRoleColumnExists } from "@/lib/better-auth-db";
import {
  resolveTeamSurfaceAccess,
  TEAM_SURFACE_REFUSAL_REASON,
} from "@/lib/team-surface-access";

import {
  createEntityDashboardAction,
  deleteEntityDashboardAction,
  getEntityDashboardConfigAction,
  listEntityDashboardsAction,
  renameEntityDashboardAction,
  saveEntityDashboardConfigAction,
} from "../actions";
import type { DashboardEntityRef } from "../store/entity-identity";
import type { DashboardConfigV1_1 } from "../store/dashboard-config";
import type {
  DeletedEntityDashboard,
  EntityDashboardsList,
  MutatedEntityDashboard,
  SavedEntityDashboard,
} from "../entity-dashboards-contract";

/** Thrown when the live session may not operate this team's dashboards. Fails
 *  closed identically for an unknown team and a caller who may not view one, so
 *  a probe reveals nothing. The message names the SAME reason the page's
 *  refusal draws (cinatra#3787): a role on the team, never the session's active
 *  organization. Surfaces to the shell as a generic load/mutation failure (a
 *  revoked-access replay is a rare edge). */
class TeamDashboardAccessError extends Error {
  constructor() {
    super(
      `team dashboards (${TEAM_SURFACE_REFUSAL_REASON}): the caller is not a member of this team and holds no role that manages it`,
    );
    this.name = "TeamDashboardAccessError";
  }
}

/**
 * Re-authorize the live session for `teamId` and return the server-derived,
 * user-owned entity ref. Runs on every guarded action call.
 */
async function authorizeTeamDashboards(teamId: string): Promise<DashboardEntityRef> {
  const session = await requireAuthSession();
  const userId = session.user.id;

  // Tenant: read the team BY ID and take its organization from the row. An
  // unknown team is indistinguishable from one the caller may not view.
  const teamRows = await betterAuthDb.execute<{ organizationId: string }>(sql`
    SELECT "organizationId" FROM public."team"
     WHERE id = ${teamId}
     LIMIT 1
  `);
  const team = teamRows.rows?.[0];
  if (!team) throw new TeamDashboardAccessError();

  // View authority (mirrors the screen gate): a team member OR a manager
  // (team admin / an owner or admin of the TEAM's organization / platform
  // admin). The organization role is resolved against the team's organization.
  const rolesEnabled = await teamMemberRoleColumnExists();
  const memberRows = await betterAuthDb.execute<{ role?: string | null }>(
    rolesEnabled
      ? sql`
          SELECT role FROM public."teamMember"
           WHERE "teamId" = ${teamId} AND "userId" = ${userId} LIMIT 1
        `
      : sql`
          SELECT "userId" FROM public."teamMember"
           WHERE "teamId" = ${teamId} AND "userId" = ${userId} LIMIT 1
        `,
  );
  const memberRow = memberRows.rows?.[0];
  const teamRole =
    rolesEnabled && memberRow ? (memberRow.role === "admin" ? "admin" : "member") : undefined;
  const orgRole = await resolveOrgRoleForUser(team.organizationId, userId);
  const access = resolveTeamSurfaceAccess({
    team,
    isMember: memberRow !== undefined,
    platformAdmin: isPlatformAdmin(session),
    orgRole,
    ...(teamRole ? { teamRole } : {}),
  });
  if (access.outcome !== "allowed") throw new TeamDashboardAccessError();

  // The ref carries the team's organization, so the delegate files and lists
  // under the TEAM's tenant whatever organization the session has active.
  return {
    entityType: "team",
    entityId: teamId,
    ownerLevel: "user",
    ownerId: userId,
    organizationId: team.organizationId,
  };
}

export async function teamListDashboardsAction(
  teamId: string,
): Promise<EntityDashboardsList> {
  return listEntityDashboardsAction(await authorizeTeamDashboards(teamId));
}

export async function teamLoadDashboardConfigAction(
  teamId: string,
  id: string,
): Promise<DashboardConfigV1_1> {
  return getEntityDashboardConfigAction(await authorizeTeamDashboards(teamId), id);
}

export async function teamCreateDashboardAction(
  teamId: string,
  name: string,
): Promise<MutatedEntityDashboard> {
  return createEntityDashboardAction(await authorizeTeamDashboards(teamId), name);
}

export async function teamRenameDashboardAction(
  teamId: string,
  id: string,
  name: string,
): Promise<MutatedEntityDashboard> {
  return renameEntityDashboardAction(await authorizeTeamDashboards(teamId), id, name);
}

export async function teamDeleteDashboardAction(
  teamId: string,
  id: string,
): Promise<DeletedEntityDashboard> {
  return deleteEntityDashboardAction(await authorizeTeamDashboards(teamId), id);
}

export async function teamSaveDashboardConfigAction(
  teamId: string,
  id: string,
  config: unknown,
): Promise<SavedEntityDashboard> {
  return saveEntityDashboardConfigAction(await authorizeTeamDashboards(teamId), id, config);
}
