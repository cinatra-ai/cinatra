/**
 * `/teams/[teamId]` screen — the team detail dashboards surface (cinatra#704,
 * epic #699; Permissions tab dropped by cinatra#1688).
 *
 * WHAT THIS TAB DRAWS (rebuilt to the ratified drawing by cinatra#2807 fix leg
 * 3). The drawing's Dashboards-tab section fixes it: the caption "The dashboards
 * in Team: <name>." over the scope's rows — homed and secondary-listed alike,
 * no relation badge — and, for a scope manager only, "Add dashboard" at the
 * right of that caption row (§IX.2: "Suppression, not a disabled control").
 *
 * WHAT IT NO LONGER DRAWS, and why. This landing used to stack a dashboard
 * canvas above that panel: a toolbar band, an Overview selector, a Team card and
 * a members counts card. The section names none of them, and it sends identity
 * and membership to the Settings entry in its own words — "that entity's
 * management pane, where rename, visibility and the members / access section
 * live folded together". The Components Toolbar rule forbids the band's
 * placement outright ("never stack a toolbar and the etched paired rule"). Each
 * dashboard is opened at its canonical surface: "the tab points, it never
 * renders a dashboard inline".
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
import { notFound, redirect } from "next/navigation";
import { sql } from "drizzle-orm";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { EntityScopeTabs } from "@/components/entity-scope-tabs";
import { ScopeDashboardsSection } from "@/components/dashboards/scope-dashboards-section";
import { ScopeAddSourcesProvider } from "@/components/dashboards/scope-add-sources";
import { buildScopeReferenceSource } from "@/components/dashboards/scope-reference-binding";
import { buildScopeCatalogNode } from "@/components/dashboards/scope-catalog-node";
import {
  getActorContext,
  isPlatformAdmin,
  requireAuthSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import { betterAuthDb, teamMemberRoleColumnExists } from "@/lib/better-auth-db";
import { CrumbContributions } from "@/components/crumb-contributions";
import { canManageTeamMembers } from "@/app/teams/[teamId]/settings/team-member-authority";
import type { TeamMemberView } from "@/app/teams/[teamId]/settings/team-members-section";


type TeamRow = {
  id: string;
  name: string;
  organizationId: string;
  org_name: string;
  is_member: boolean;
};

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

  // The #1897 scope collection folded onto this landing (cinatra#2474 PR2). The
  // actor drives the §IX.2 write gate inside the section (`actorMayWriteScope`:
  // team admin, or an org owner/admin of the team's org, tenant-fenced) — the
  // gate above is the READ population (§IX.2: a member without write authority
  // still sees every row and opens any of them, with no Add and no Remove).
  const actor = await getActorContext();
  const scope = {
    kind: "team",
    scopeId: team.id,
    orgId: team.organizationId,
  } as const;

  // The §IX.1 add-to-scope source for the unified Add-dashboard popup
  // (cinatra#2474 PR3) — `null` for anyone who may not write this scope, so a
  // read-only member gets no scope-level Add affordance and no handle to the
  // add actions (§IX.2 suppression, applied before anything reaches the browser).
  const scopeReference = actor ? buildScopeReferenceSource(actor, scope) : null;
  const scopeLabel = `Team: ${team.name}`;

  // Concept B's installed-catalog section — the node that fills the slot the
  // unified popup leaves for it. Read server-side against THIS team's vantage
  // and THIS actor's own destination collection; `null` whenever nothing is
  // eligible, in which case the popup simply carries no catalog section.
  const catalog = await buildScopeCatalogNode({
    actor,
    surface: { kind: "team", orgId: scope.orgId, scopeId: team.id, userId },
  });

  // Create-new, preserved through the removal of the toolbar band that used to
  // carry it. Offered only alongside the manager's Add; the action re-authorizes
  // the live session on every call (tenant + view authority).
  // NOTE (fix leg 3, convergence round): the popup's create and installed-catalog
  // paths are NOT wired from this landing. Both write a row owned by the acting
  // user, and this tab reads the SCOPE's collection, so a copy made through them
  // would report success and then appear nowhere here. The drawn Add is the
  // add-to-scope picker; where the other two belong is recorded on the pull
  // request for the maintainer.

  return (
    <Main className="min-h-screen">
      {/* Post-gate crumb publisher (cinatra#1737): both gates above passed,
          so the team name may reach the breadcrumb. */}
      <CrumbContributions
        entries={[{ prefix: `/teams/${encodeURIComponent(team.id)}`, label: team.name }]}
      />
      <PageHeader
        label="Team"
        title={team.name}
        description={`Team in ${team.org_name}`}
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* The entity-page tablist (cinatra#2474 PR1, spec §IX): this landing IS
            the Dashboards tab; Settings is the second entry. Rendered for every
            member — the settings page owns the read-only/manage split. */}
        <EntityScopeTabs
          dashboardsHref={`/teams/${encodeURIComponent(team.id)}`}
          assistantsHref={`/teams/${encodeURIComponent(team.id)}/assistants`}
          agentsHref={`/teams/${encodeURIComponent(team.id)}/agents`}
          artifactsHref={`/teams/${encodeURIComponent(team.id)}/artifacts`}
          skillsHref={`/teams/${encodeURIComponent(team.id)}/skills`}
          settingsHref={`/teams/${encodeURIComponent(team.id)}/settings`}
          active="dashboards"
        />
        {/* The Dashboards tab body. The provider hands the drawn Add
            affordance its sources; what crosses is server-bound actions and a
            label, never the actor or the scope's owner axis. */}
        {actor ? (
          <ScopeAddSourcesProvider
            scopeLabel={scopeLabel}
            reference={scopeReference}
            catalog={catalog}
          >
            <ScopeDashboardsSection
              actor={actor}
              scope={scope}
              entityLabel={scopeLabel}
            />
          </ScopeAddSourcesProvider>
        ) : null}
      </PageContent>
    </Main>
  );
}
