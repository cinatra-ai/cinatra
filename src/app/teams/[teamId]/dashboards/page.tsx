import "server-only";
import { notFound, redirect } from "next/navigation";
import { sql } from "drizzle-orm";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { CrumbContributions } from "@/components/crumb-contributions";
import { requireAuthSession, requireActorContext } from "@/lib/auth-session";
import { betterAuthDb } from "@/lib/better-auth-db";
import { actorMayWriteScope } from "@/lib/dashboards/scope-write-authority";
import { EntityScopeTabs } from "@/components/entity-scope-tabs";
import { ScopeDashboardsSection } from "@/components/dashboards/scope-dashboards-section";

type Props = { params: Promise<{ teamId: string }> };

/**
 * The TEAM entity page's Dashboards tab (cinatra#1897 B4; the ratified design
 * spec at design@0ead5d0c5 §IX). The page IS the entity — h1 = the team name +
 * kind label, with the canonical underline tablist (Dashboards · Settings)
 * beneath (Settings mounts the existing `/teams/[teamId]/settings` surface).
 * Mounts at `/teams/[teamId]/dashboards` — the dedicated
 * scope-collection route (previously a bare crumb redirect, cinatra#1738 D2) —
 * so it leaves the per-user team-detail dashboards shell (`/teams/[teamId]`,
 * #704) untouched. Read stays universal (every team member sees the tab + every
 * row + opens any of them); only the Add/Remove management controls are gated to
 * a scope manager (§IX.2, `actorMayWriteScope`).
 */
export default async function TeamScopeDashboardsPage({ params }: Props) {
  const { teamId } = await params;
  const session = await requireAuthSession();
  const actor = await requireActorContext();

  const rows = await betterAuthDb.execute<{
    id: string;
    name: string;
    organizationId: string;
  }>(sql`
    SELECT id, name, "organizationId" FROM public."team" WHERE id = ${teamId} LIMIT 1
  `);
  const team = rows.rows?.[0];
  if (!team) notFound();

  // Tenant-alignment gate (the team-detail-page precedent): the scope reads run
  // under the actor's active org, so the team must be in it.
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  if (activeOrgId !== team.organizationId) redirect("/not-authorized");

  const scope = {
    kind: "team" as const,
    scopeId: team.id,
    orgId: team.organizationId,
  };
  // View gate: a team member OR a scope manager (read-only for members, §IX.2).
  const isMember = (actor.teamIds ?? []).includes(team.id);
  if (!isMember && !actorMayWriteScope(actor, scope)) {
    redirect("/not-authorized");
  }

  return (
    <Main className="min-h-screen">
      <CrumbContributions
        entries={[
          { prefix: `/teams/${encodeURIComponent(team.id)}`, label: team.name },
          {
            prefix: `/teams/${encodeURIComponent(team.id)}/dashboards`,
            label: "Dashboards",
          },
        ]}
      />
      <PageHeader label="Team" title={team.name} divider={false} />
      <PageContent className="flex flex-col gap-5 pb-8">
        <EntityScopeTabs
          dashboardsHref={`/teams/${encodeURIComponent(team.id)}/dashboards`}
          settingsHref={`/teams/${encodeURIComponent(team.id)}/settings`}
          active="dashboards"
        />
        <ScopeDashboardsSection
          actor={actor}
          scope={scope}
          scopeLabel={`Team: ${team.name}`}
        />
      </PageContent>
    </Main>
  );
}
