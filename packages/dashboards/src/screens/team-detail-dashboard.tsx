/**
 * `/teams/[teamId]` screen — per-team detail DC dashboard.
 *
 * Mirrors the `teams-dashboard.tsx` shell but renders a read-only DC dashboard
 * scoped to the single team via a same-cube `equals` filter (see
 * `entity-detail-config.ts`). Resolves the live `/teams/[teamId]` 404 (the
 * `/teams` linked table already points rows here). `/teams/[teamId]/settings`
 * stays reachable — it is a sibling route segment, not shadowed by this one.
 *
 * Authz: the redirect gate uses the session SecurityContext; the cube DATA is
 * scoped by the cubejs route's per-cube visibility resolver
 * (`WHERE id IN (visibleTeamIds)`) intersected with the `teams.id = teamId`
 * filter — an inaccessible team yields zero rows (fail closed).
 */
import "server-only";
import { redirect } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";

import { getAuthSession } from "@/lib/auth-session";

import { buildSecurityContextFromSession } from "../auth/security-context";
import { DashboardGridContainer } from "../components/dashboard-grid-container";
import { DashboardsClientShell } from "../components/dashboards-client-shell";
import { buildTeamDetailConfig } from "../components/seed-configs/entity-detail-config";

export async function TeamDetailDashboardPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect("/sign-in");
  }

  const initialConfig = buildTeamDetailConfig(teamId);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Team"
        description="Team overview."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <DashboardsClientShell>
          <DashboardGridContainer initialConfig={initialConfig} editable={false} />
        </DashboardsClientShell>
      </PageContent>
    </Main>
  );
}
