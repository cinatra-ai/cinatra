/**
 * `/teams/[teamId]` screen — the team detail dashboards surface (cinatra#704,
 * epic #699; Permissions tab dropped by cinatra#1688).
 *
 * The reusable entity Dashboards surface (#701) bound to this team's PER-USER
 * dashboard set. The non-removable "Overview" default (#700) holds the team's
 * general info — identity + member count — rendered as the render-only summary
 * portlets (#702) built fresh here via `buildTeamOverviewConfig`; the user may
 * also create/select their own custom dashboards for the team.
 *
 * Team MANAGEMENT (membership + per-team roles + rename) lives ONLY at
 * `/teams/[teamId]/settings`, reached via the header button (cinatra#1688: the
 * former "Permissions" tab mounted the same `TeamMembersSection` a second time
 * — the settings page absorbed it as THE single management surface).
 *
 * Ownership axis (converged decision): team detail dashboards are USER-owned
 * (`ownerLevel:"user"`, `ownerId:userId`) — "the user's dashboards for this
 * entity" (epic vision). This keeps the LANDED foundation's actor complete
 * (`requireEntityDashboardActor` needs no team-role resolution) and matches the
 * personal surface; a team-OWNED shared model would be a larger, separate change
 * the AC does not require.
 *
 * Access: TWO conditions.
 *   1. Tenant alignment — the team must belong to the viewer's ACTIVE
 *      organization. The entity-dashboard actions derive their org from the
 *      active org (org is the ambient tenant), so viewing a team outside it
 *      would file/read that team's Overview + custom dashboards under the WRONG
 *      tenant (a foreign team id under the active org). Requiring the match keeps
 *      the persisted rows tenant-consistent with the team and the access gate
 *      (codex #704 convergence). A team reached from `/teams` (the active-org
 *      list) always satisfies this; a cross-active-org deep link redirects.
 *   2. Authority — a team member OR a manager (team admin / org owner-admin /
 *      platform admin of the team's org), the same predicate the settings
 *      surface uses. Membership alone views; management adds the write controls.
 * The Overview summary is fetched directly (the actor is already gated); the
 * custom dashboards stay user-owned + row/ref-confined + capability-derived
 * server-side.
 */
import "server-only";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { Settings } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  isPlatformAdmin,
  requireAuthSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import { betterAuthDb, teamMemberRoleColumnExists } from "@/lib/better-auth-db";
import { CrumbContributions } from "@/components/crumb-contributions";
import { canManageTeamMembers } from "@/app/teams/[teamId]/settings/team-member-authority";
import type { TeamMemberView } from "@/app/teams/[teamId]/settings/team-members-section";

import { buildTeamOverviewConfig } from "../components/seed-configs/overview-config";
import { TeamDetailDashboards } from "../components/team-detail-dashboards";
import type { DashboardEntityRef } from "../store/entity-identity";
import type { DashboardConfigV1_1 } from "../store/dashboard-config";
import { ensureEntityOverviewAction, listEntityDashboardsAction } from "../actions";
import {
  teamCreateDashboardAction,
  teamDeleteDashboardAction,
  teamListDashboardsAction,
  teamLoadDashboardConfigAction,
  teamRenameDashboardAction,
  teamSaveDashboardConfigAction,
} from "./team-detail-dashboard-actions";

type TeamRow = {
  id: string;
  name: string;
  organizationId: string;
  org_name: string;
  is_member: boolean;
};

/** Placeholder DC config for the SSR seed's initial selection. The initial
 *  selection is always the render-only Overview (its persisted row config is
 *  empty and never rendered — the summary comes from `overviewPortlets`), so
 *  this value is structural only. */
const EMPTY_SEED_CONFIG = {
  portlets: [],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as unknown as DashboardConfigV1_1;

export async function TeamDetailDashboardPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const session = await requireAuthSession();
  const userId = session.user.id;

  const teamRows = await betterAuthDb.execute<TeamRow>(sql`
    SELECT
      t.id,
      t.name,
      t."organizationId",
      o.name AS org_name,
      EXISTS (
        SELECT 1 FROM public."teamMember" tm
         WHERE tm."teamId" = t.id AND tm."userId" = ${userId}
      ) AS is_member
    FROM public."team" t
    JOIN public."organization" o ON o.id = t."organizationId"
    WHERE t.id = ${teamId}
    LIMIT 1
  `);
  const team = teamRows.rows?.[0];
  if (!team) notFound();

  // Tenant-alignment gate (codex #704): the entity-dashboard actions operate
  // under the session's ACTIVE organization, so the team must be in it — else a
  // member deep-linking a team outside their active org would file/read its
  // dashboards under the wrong tenant. `resolveOrgRoleForUser` / `is_member`
  // below then resolve against this same (active == team) org.
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  if (activeOrgId !== team.organizationId) redirect("/not-authorized");

  // Members list (+ per-team roles when the app-owned `teamMember.role` column
  // is provisioned) — the same fetch the settings surface uses. Needed here for
  // the Overview member count and the viewer's per-team role (authority gate);
  // the members UI itself renders only on `/teams/[teamId]/settings` (#1688).
  const rolesEnabled = await teamMemberRoleColumnExists();
  const memberRows = await betterAuthDb.execute<{
    userId: string;
    name: string | null;
    email: string | null;
    role?: string | null;
  }>(
    rolesEnabled
      ? sql`
          SELECT tm."userId", u.name, u.email, tm.role
            FROM public."teamMember" tm
            JOIN public."user" u ON u.id = tm."userId"
           WHERE tm."teamId" = ${team.id}
           ORDER BY u.name, tm."userId"
        `
      : sql`
          SELECT tm."userId", u.name, u.email
            FROM public."teamMember" tm
            JOIN public."user" u ON u.id = tm."userId"
           WHERE tm."teamId" = ${team.id}
           ORDER BY u.name, tm."userId"
        `,
  );
  const members: TeamMemberView[] = (memberRows.rows ?? []).map((row) => ({
    userId: row.userId,
    name: row.name ?? row.email ?? "Unknown",
    email: row.email ?? "",
    role: rolesEnabled ? (row.role === "admin" ? "admin" : "member") : null,
  }));

  // View + manage gate (mirrors `/teams/[teamId]/settings`): a team member keeps
  // access; a manager (team admin / org owner-admin / platform admin) additionally
  // manages membership and may view without a membership row.
  const orgRole = await resolveOrgRoleForUser(team.organizationId, userId);
  const viewerRole = members.find((m) => m.userId === userId)?.role;
  const canManage = canManageTeamMembers({
    platformAdmin: isPlatformAdmin(session),
    orgRole,
    ...(viewerRole ? { teamRole: viewerRole } : {}),
  });
  if (!team.is_member && !canManage) redirect("/not-authorized");

  // ── Dashboards tab wiring (#700/#701/#702) ──────────────────────────────────
  // User-owned team-detail dashboards. Ensure the non-removable Overview BEFORE
  // listing (the shell never seeds it), then bind the ref into the server
  // actions the client shell drives (the ref crosses Next-encrypted; the client
  // never authors the owner axis).
  const ref: DashboardEntityRef = {
    entityType: "team",
    entityId: team.id,
    ownerLevel: "user",
    ownerId: userId,
  };
  await ensureEntityOverviewAction(ref);
  const list = await listEntityDashboardsAction(ref);

  // The Overview's LIVE content — the team's current summary as render-only
  // portlets (#702). Built fresh per request and handed to `<PortletHost>`, so
  // it can never be a stale/authorization-obsolete saved row.
  const overviewConfig = buildTeamOverviewConfig({
    name: team.name,
    organizationName: team.org_name,
    memberCount: members.length,
  });

  const overview = list.dashboards.find((d) => d.isDefault);
  const selectedId = overview?.id ?? list.dashboards[0]?.id;
  const initialData = selectedId
    ? { list, selectedId, config: EMPTY_SEED_CONFIG }
    : undefined;

  // The CLIENT-invoked actions bind only the server-derived teamId and
  // re-authorize the live session on every call (tenant + view authority) — the
  // render gate above cannot protect a later invocation after an org switch.
  const dataSource = {
    listDashboards: teamListDashboardsAction.bind(null, team.id),
    loadConfig: teamLoadDashboardConfigAction.bind(null, team.id),
    createDashboard: teamCreateDashboardAction.bind(null, team.id),
    renameDashboard: teamRenameDashboardAction.bind(null, team.id),
    deleteDashboard: teamDeleteDashboardAction.bind(null, team.id),
    saveDashboard: teamSaveDashboardConfigAction.bind(null, team.id),
  };

  return (
    <Main className="min-h-screen">
      {/* Post-gate crumb publisher (cinatra#1737): both gates above passed,
          so the team name may reach the breadcrumb. */}
      <CrumbContributions
        entries={[{ prefix: `/teams/${encodeURIComponent(team.id)}`, label: team.name }]}
      />
      <PageHeader
        title={team.name}
        description={`Team in ${team.org_name}`}
        divider={false}
        actions={
          <Button asChild variant="outline">
            <Link href={`/teams/${encodeURIComponent(team.id)}/settings`}>
              <Settings data-icon="inline-start" aria-hidden="true" />
              Team settings
            </Link>
          </Button>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <TeamDetailDashboards
          dataSource={dataSource}
          overviewPortlets={overviewConfig.portlets}
          initialData={initialData}
        />
      </PageContent>
    </Main>
  );
}
