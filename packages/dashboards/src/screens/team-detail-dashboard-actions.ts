"use server";
/**
 * Guarded team-detail dashboard actions (cinatra#704, codex convergence).
 *
 * The generic entity-dashboard actions (`actions.ts`) derive their org from the
 * CURRENT session's active org and confine every mutation by the bound ref, but
 * — for the per-INSTANCE entity types (team/org/project) — they do NOT verify
 * that the bound entity belongs to the actor's active org OR that the actor may
 * view it. On the personal/index surfaces `entityId` IS the active org, so no
 * gap exists; on a team detail page `entityId` is a team id, so a stale bound
 * action replayed after an org switch (another tab) — or after the caller lost
 * access — could file/read a foreign team ref under the newly active org.
 *
 * These thin `"use server"` wrappers bind ONLY the server-derived `teamId` and,
 * on EVERY invocation, re-authorize from the LIVE session before delegating:
 *   1. re-derive the owner axis from the session (`ownerId = session user`,
 *      never a client-supplied owner);
 *   2. confirm the team is in the caller's ACTIVE org (the org the delegate
 *      operates under) — closes the cross-tenant replay; and
 *   3. confirm the caller may VIEW the team (member OR manager), the same gate
 *      the screen and `/teams/[teamId]/settings` apply.
 * A switched-org / revoked-access replay fails CLOSED here (throws) instead of
 * persisting or reading a cross-tenant row. The delegate then re-confines by the
 * ref + `ownerId`, so a caller only ever reaches their OWN private rows.
 *
 * Not guarded here: `ensureEntityOverviewAction` + the SSR `listEntity…` run
 * only server-side inside the screen render, AFTER its identical page gate, in
 * the same request — never from a stale client.
 */
import { sql } from "drizzle-orm";

import {
  isPlatformAdmin,
  requireAuthSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import { betterAuthDb, teamMemberRoleColumnExists } from "@/lib/better-auth-db";
import { canManageTeamMembers } from "@/app/teams/[teamId]/settings/team-member-authority";

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
 *  closed identically for "team not in active org" and "caller may not view",
 *  so a probe reveals nothing. Surfaces to the shell as a generic load/mutation
 *  failure (the switched-org / revoked-access replay is a rare edge). */
class TeamDashboardAccessError extends Error {
  constructor() {
    super("team dashboards: not authorized for this team in the active organization");
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
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  if (!activeOrgId) throw new TeamDashboardAccessError();

  // Tenant: the team must be in the caller's ACTIVE org (the delegate's ambient
  // tenant). A team in another org is indistinguishable from a missing one.
  const teamRows = await betterAuthDb.execute<{ id: string }>(sql`
    SELECT id FROM public."team"
     WHERE id = ${teamId} AND "organizationId" = ${activeOrgId}
     LIMIT 1
  `);
  if ((teamRows.rows?.length ?? 0) === 0) throw new TeamDashboardAccessError();

  // View authority (mirrors the screen gate): a team member OR a manager
  // (team admin / org owner-admin of the active==team org / platform admin).
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
  const isMember = memberRow !== undefined;
  const teamRole =
    rolesEnabled && memberRow ? (memberRow.role === "admin" ? "admin" : "member") : undefined;
  const orgRole = await resolveOrgRoleForUser(activeOrgId, userId);
  const canManage = canManageTeamMembers({
    platformAdmin: isPlatformAdmin(session),
    orgRole,
    ...(teamRole ? { teamRole } : {}),
  });
  if (!isMember && !canManage) throw new TeamDashboardAccessError();

  return { entityType: "team", entityId: teamId, ownerLevel: "user", ownerId: userId };
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
