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
 * Access: ONE condition, authority over THIS team (cinatra#3787). A team member
 * OR a manager (team admin / an owner or admin of the TEAM's organization /
 * platform admin) opens this landing, the same predicate the settings surface
 * and the team's name read apply, and the same one `/teams/[teamId]/agents`
 * already applied. A caller who holds neither is refused with the reason that is
 * true of them (`/not-authorized?reason=scope-membership`), never the
 * platform-admin sentence.
 *
 * WHAT WAS DROPPED, and why it is safe. A tenant-alignment gate used to come
 * FIRST: the team had to belong to the viewer's ACTIVE organization, else the
 * page redirected. Its reason (codex #704 convergence) was the entity-dashboard
 * actions, which derived their organization from the session, so a team outside
 * the active organization would have filed its dashboards under the wrong
 * tenant. The gate stood ahead of the authority gate below, so the platform
 * admin, owner of every organization and admin of the team, was refused too,
 * and was told the area is limited to platform admins.
 *
 * The tenant is now carried, not assumed: `authorizeTeamDashboards` names the
 * team's organization on the ref and the delegate files under it, so the wrong
 * tenant is unreachable and the gate has nothing left to guard. This is the
 * owner's decision on cinatra#3693 applied to the landing: "a launch from a
 * scope's tab belongs to that scope's organization, whatever the session's
 * active organization is". It makes the team landing read like the project
 * landing, which never compared the active organization at all. Everything this
 * page builds for the scope already used `team.organizationId`, and still does.
 *
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
import {
  resolveTeamSurfaceAccess,
  TEAM_SURFACE_REFUSAL_REASON,
} from "@/lib/team-surface-access";
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

  // View + manage gate (mirrors `/teams/[teamId]/settings` and the team's name
  // read): a team member keeps access; a manager (team admin / an owner or admin
  // of the TEAM's organization / platform admin) additionally manages membership
  // and may view without a membership row. The organization role is resolved
  // against `team.organizationId`, which is this surface's tenant; the session's
  // active organization plays no part in the decision.
  const orgRole = await resolveOrgRoleForUser(team.organizationId, userId);
  const viewerRole = members.find((m) => m.userId === userId)?.role;
  const access = resolveTeamSurfaceAccess({
    team,
    isMember: team.is_member,
    platformAdmin: isPlatformAdmin(session),
    orgRole,
    ...(viewerRole ? { teamRole: viewerRole } : {}),
  });
  // The refusal names what the reader actually lacks: a role on this team.
  if (access.outcome !== "allowed") {
    redirect(`/not-authorized?reason=${TEAM_SURFACE_REFUSAL_REASON}`);
  }

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
