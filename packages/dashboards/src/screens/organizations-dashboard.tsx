/**
 * `/organizations` screen. Mirrors `projects-dashboard.tsx`.
 */
import "server-only";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";

import { getAuthSession } from "@/lib/auth-session";

import { buildSecurityContextFromSession } from "../auth/security-context";

import { dashboards, getDashboardsDb } from "../store/db";
import {
  parseDashboardConfig,
  type DashboardConfigV1_1,
} from "../store/dashboard-config";
import { readDcConfigFromRow } from "../v12-envelope";
import {
  ORGANIZATIONS_DEFAULT_CONFIG,
  buildOrganizationsDashboardId,
} from "../components/seed-configs/organizations-default";
import { AnalyticsPortletView } from "../components/analytics-portlet-view";
import { saveOrganizationsDashboardAction } from "../actions";

async function loadOrganizationsConfig(
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
  // Unwrap the apiVersion 1.2 analytics envelope back to the bare drizzle-cube
  // config the grid mounts (legacy rows parse via the dispatcher; absent/corrupt
  // → seed). #328 swaps only the RENDER to AnalyticsPortletView (the PortletHost
  // grid renderer); the data shape stays the bare DC config the view mounts.
  return readDcConfigFromRow(rows[0], ORGANIZATIONS_DEFAULT_CONFIG, parseDashboardConfig);
}

export async function OrganizationsDashboardPage() {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect("/sign-in");
  }
  const dashboardId = buildOrganizationsDashboardId(
    ctx.organizationId,
    ctx.userId,
  );
  const initialConfig = await loadOrganizationsConfig(
    dashboardId,
    ctx.organizationId,
    ctx.userId,
  );

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Organizations"
        description="Organizations you are a member of."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <AnalyticsPortletView
          dashboard={initialConfig}
          editable
          onSave={saveOrganizationsDashboardAction}
          dashboardModes={["grid", "rows"]}
        />
      </PageContent>
    </Main>
  );
}
