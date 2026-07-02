/**
 * `/personal` screen. Mirrors `organizations-dashboard.tsx`.
 *
 * Migrated from the legacy `DeskDashboardGrid` + `DashboardsClientShell` to the
 * shared `<EmbeddedDrizzleCubeDashboardGrid>` (the single PortletHost grid
 * renderer, #328) so Personal gains the grey portlet toolbar, the
 * Edit-dashboard affordance, and the same empty-state chrome the other
 * Management dashboards have (cinatra#626). Personal is "built from the cards
 * you add", so it seeds an EMPTY grid and persists per-user. No `pageAnchor`
 * and no `PageHeader actions` button: like /organizations it has no
 * route-scoped primary action — adding cards is the portlet toolbar's job.
 * It also keeps the default grid-only layout (no Grid/Rows toggle), matching
 * the ratified `dashboard-modes.test.ts` contract that excludes Personal from
 * rows mode.
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
import { type DashboardConfigV1_1 } from "../store/dashboard-config";
import { readDcConfigFromRow } from "../v12-envelope";
import {
  PERSONAL_DEFAULT_CONFIG,
  buildPersonalDashboardId,
} from "../components/seed-configs/personal-default";
import { EmbeddedDrizzleCubeDashboardGrid } from "../components/embedded-drizzle-cube-dashboard-grid";
import { savePersonalDashboardAction } from "../actions";

async function loadPersonalConfig(
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
  // config the grid mounts (an absent/corrupt/non-1.2 row falls back to the
  // empty seed). #626 renders via EmbeddedDrizzleCubeDashboardGrid (the
  // PortletHost grid renderer); the data shape stays the bare DC config the
  // view mounts.
  return readDcConfigFromRow(rows[0], PERSONAL_DEFAULT_CONFIG);
}

export async function PersonalDashboardPage() {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect("/sign-in");
  }
  const dashboardId = buildPersonalDashboardId(ctx.organizationId, ctx.userId);
  const initialConfig = await loadPersonalConfig(
    dashboardId,
    ctx.organizationId,
    ctx.userId,
  );

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Personal"
        description="Your private dashboard, built from the cards you add."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <EmbeddedDrizzleCubeDashboardGrid
          dashboard={initialConfig}
          editable
          onSave={savePersonalDashboardAction}
        />
      </PageContent>
    </Main>
  );
}
