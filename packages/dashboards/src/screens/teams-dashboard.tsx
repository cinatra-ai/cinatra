/**
 * `/teams` screen. Mirrors `projects-dashboard.tsx`.
 */
import "server-only";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Plus } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

import { getAuthSession } from "@/lib/auth-session";

import { buildSecurityContextFromSession } from "../auth/security-context";

import { dashboards, getDashboardsDb } from "../store/db";
import {
  parseDashboardConfig,
  type DashboardConfigV1_1,
} from "../store/dashboard-config";
import {
  TEAMS_DEFAULT_CONFIG,
  buildTeamsDashboardId,
} from "../components/seed-configs/teams-default";
import { DashboardGridContainer } from "../components/dashboard-grid-container";
import { DashboardsClientShell } from "../components/dashboards-client-shell";
import { saveTeamsDashboardAction } from "../actions";

async function loadTeamsConfig(
  dashboardId: string,
  organizationId: string,
  ownerId: string,
): Promise<DashboardConfigV1_1> {
  const db = getDashboardsDb();
  const rows = await db
    .select()
    .from(dashboards)
    .where(
      and(
        eq(dashboards.id, dashboardId),
        eq(dashboards.organizationId, organizationId),
        eq(dashboards.ownerId, ownerId),
        eq(dashboards.ownerLevel, "user"),
      ),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) return TEAMS_DEFAULT_CONFIG;
  try {
    return parseDashboardConfig(
      existing.configVersion,
      existing.configJson,
    ) as DashboardConfigV1_1;
  } catch {
    return TEAMS_DEFAULT_CONFIG;
  }
}

export async function TeamsDashboardPage() {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect("/sign-in");
  }
  const dashboardId = buildTeamsDashboardId(ctx.organizationId, ctx.userId);
  const initialConfig = await loadTeamsConfig(
    dashboardId,
    ctx.organizationId,
    ctx.userId,
  );

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Teams"
        description="Teams visible to you."
        divider={false}
        actions={
          /* Server-rendered SSR fallback — `dashboard-theme.css` hides
             this via a `body:has(...)` rule that keys on the LIVE
             presence of the toolbar's `[data-cinatra-page-action]`
             anchor. See `cinatra-dashboard-toolbar.tsx`. */
          <div data-cinatra-page-actions-fallback="teams">
            <Button asChild>
              <Link href="/teams/new">
                <Plus data-icon="inline-start" aria-hidden="true" />
                New team
              </Link>
            </Button>
          </div>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <DashboardsClientShell pageAnchor="teams" dashboardModes={["grid", "rows"]}>
          <DashboardGridContainer
            initialConfig={initialConfig}
            editable
            onSave={saveTeamsDashboardAction}
          />
        </DashboardsClientShell>
      </PageContent>
    </Main>
  );
}
