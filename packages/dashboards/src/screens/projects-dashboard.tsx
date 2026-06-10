/**
 * `/projects` screen.
 *
 * Replaces the legacy custom-table page with a DC dashboard mounted via
 * `<DashboardsClientShell>` + `<DashboardGridContainer>`. Loads the
 * user's per-org-per-user dashboard row (or the
 * `PROJECTS_DEFAULT_CONFIG` seed) and passes it to the same
 * `cinatraLinkedTable` chart plugin used by the other dashboards
 * so Name cells render as real `<Link>`s.
 *
 * Page chrome lives in Cinatra's standard Main + PageHeader (no divider —
 * the dashboard toolbar replaces the section rule per design-spec
 * §Dividers) + PageContent shell.
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

import {
  buildSecurityContextFromSession,
} from "../auth/security-context";

import { dashboards, getDashboardsDb } from "../store/db";
import {
  parseDashboardConfig,
  type DashboardConfigV1_1,
} from "../store/dashboard-config";
import {
  PROJECTS_DEFAULT_CONFIG,
  buildProjectsDashboardId,
} from "../components/seed-configs/projects-default";
import { DashboardGridContainer } from "../components/dashboard-grid-container";
import { DashboardsClientShell } from "../components/dashboards-client-shell";
import { saveProjectsDashboardAction } from "../actions";

async function loadProjectsConfig(
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
  if (!existing) return PROJECTS_DEFAULT_CONFIG;
  try {
    return parseDashboardConfig(
      existing.configVersion,
      existing.configJson,
    ) as DashboardConfigV1_1;
  } catch {
    return PROJECTS_DEFAULT_CONFIG;
  }
}

export async function ProjectsDashboardPage() {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect("/sign-in");
  }
  const dashboardId = buildProjectsDashboardId(ctx.organizationId, ctx.userId);
  const initialConfig = await loadProjectsConfig(
    dashboardId,
    ctx.organizationId,
    ctx.userId,
  );

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Projects"
        description="Projects you own or have access to."
        divider={false}
        actions={
          /* Server-rendered SSR fallback — `dashboard-theme.css` hides
             this via a `body:has(...)` rule that keys on the LIVE
             presence of the toolbar's `[data-cinatra-page-action]`
             anchor. See `cinatra-dashboard-toolbar.tsx`. */
          <div data-cinatra-page-actions-fallback="projects">
            <Button asChild>
              <Link href="/projects/new">
                <Plus data-icon="inline-start" aria-hidden="true" />
                New project
              </Link>
            </Button>
          </div>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <DashboardsClientShell pageAnchor="projects" dashboardModes={["grid", "rows"]}>
          <DashboardGridContainer
            initialConfig={initialConfig}
            editable
            onSave={saveProjectsDashboardAction}
          />
        </DashboardsClientShell>
      </PageContent>
    </Main>
  );
}
