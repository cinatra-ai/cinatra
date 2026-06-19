/**
 * `/artifacts` screen. Mirrors `projects-dashboard.tsx`.
 *
 * The artifacts cube's Name column renders as a `<Link>` to
 * `/artifacts/[id]` per the `cinatraLinkedTable` plugin mapping. The
 * receiving detail route + the link target must ship together — a
 * revert that removes the detail route MUST also remove the
 * `artifacts` entry from `CUBE_NAME_LINK_TEMPLATES` to avoid a dead
 * link.
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
  ARTIFACTS_DEFAULT_CONFIG,
  buildArtifactsDashboardId,
} from "../components/seed-configs/artifacts-default";
import { DashboardGridContainer } from "../components/dashboard-grid-container";
import { DashboardsClientShell } from "../components/dashboards-client-shell";
import { saveArtifactsDashboardAction } from "../actions";

async function loadArtifactsConfig(
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
  // → seed). The screen stays on the legacy grid (#328 switches it to PortletHost).
  return readDcConfigFromRow(rows[0], ARTIFACTS_DEFAULT_CONFIG, parseDashboardConfig);
}

export async function ArtifactsDashboardPage() {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect("/sign-in");
  }
  const dashboardId = buildArtifactsDashboardId(
    ctx.organizationId,
    ctx.userId,
  );
  const initialConfig = await loadArtifactsConfig(
    dashboardId,
    ctx.organizationId,
    ctx.userId,
  );

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Artifacts"
        description="Files, documents, and deliverables produced by you or your agents."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <DashboardsClientShell dashboardModes={["grid", "rows"]}>
          <DashboardGridContainer
            initialConfig={initialConfig}
            editable
            onSave={saveArtifactsDashboardAction}
          />
        </DashboardsClientShell>
      </PageContent>
    </Main>
  );
}
