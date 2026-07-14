/**
 * `/organizations` screen. Mirrors `projects-dashboard.tsx`.
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
import { userCanCreateOrganizations } from "@/lib/authz/organization-create-gate";

import { buildSecurityContextFromSession } from "../auth/security-context";

import { dashboards, getDashboardsDb } from "../store/db";
import { type DashboardConfigV1_1 } from "../store/dashboard-config";
import { readDcConfigFromRow } from "../v12-envelope";
import {
  ORGANIZATIONS_DEFAULT_CONFIG,
  buildOrganizationsDashboardId,
} from "../components/seed-configs/organizations-default";
import { EmbeddedDrizzleCubeDashboardGrid } from "../components/embedded-drizzle-cube-dashboard-grid";
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
  // config the grid mounts (an absent/corrupt/non-1.2 row falls back to the
  // seed; the legacy 1.0/1.1 read path was removed in cinatra#329 after the
  // migration). #328 renders via EmbeddedDrizzleCubeDashboardGrid (the PortletHost grid
  // renderer); the data shape stays the bare DC config the view mounts.
  return readDcConfigFromRow(rows[0], ORGANIZATIONS_DEFAULT_CONFIG);
}

export async function OrganizationsDashboardPage() {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  // `!session` is implied by `!ctx` at runtime; spelled out so TypeScript
  // narrows `session` for the create-gate call below.
  if (!session || !ctx) {
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

  // cinatra#1496 — page-level creation entry, gated: org creation is
  // platform-admin-only and blocked entirely in single-org mode, so (unlike
  // teams/projects, whose creates are broadly allowed) the action renders
  // only when the viewer may actually create one. The SAME flag drives both
  // halves of the page-action pattern — the SSR PageHeader fallback and the
  // toolbar anchor — so they can never disagree.
  const canCreateOrganizations = await userCanCreateOrganizations(session);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Organizations"
        description="Organizations you are a member of."
        divider={false}
        actions={
          canCreateOrganizations ? (
            /* Server-rendered SSR fallback — `dashboard-theme.css` hides
               this via a `body:has(...)` rule that keys on the LIVE
               presence of the toolbar's `[data-cinatra-page-action]`
               anchor. See `cinatra-dashboard-toolbar.tsx`. */
            <div data-cinatra-page-actions-fallback="organizations">
              <Button asChild>
                <Link href="/organizations/new">
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  New organization
                </Link>
              </Button>
            </div>
          ) : undefined
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <EmbeddedDrizzleCubeDashboardGrid
          dashboard={initialConfig}
          editable
          onSave={saveOrganizationsDashboardAction}
          pageAnchor={canCreateOrganizations ? "organizations" : undefined}
          dashboardModes={["grid", "rows"]}
        />
      </PageContent>
    </Main>
  );
}
