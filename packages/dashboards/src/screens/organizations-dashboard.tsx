/**
 * `/organizations` screen. Mirrors `projects-dashboard.tsx`.
 */
import "server-only";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, isNotNull } from "drizzle-orm";
import { Plus } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

import { getAuthSession } from "@/lib/auth-session";
import { userCanCreateOrganizations } from "@/lib/authz/organization-create-gate";
import {
  betterAuthDb,
  betterAuthMembers,
  betterAuthOrganizations,
} from "@/lib/better-auth-db";

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

/**
 * Fixed, non-removable "Archived organizations" section (cinatra#1942 V4).
 *
 * Deliberately NOT one of the 6 registered seed configs
 * (`seed-configs-v12.test.ts`) — it is never persisted or user-editable, so
 * it is mounted read-only (`editable={false}`, no `onSave`) directly in the
 * screen's chrome, BELOW the user's editable grid, rather than as a portlet
 * inside it. Runs the SAME `organizations` cube as
 * `ORGANIZATIONS_DEFAULT_CONFIG` with the `lifecycle_status` filter flipped
 * to `archived` — the cube's own accessible-org predicate is unchanged, so
 * an archived org the viewer belongs to still surfaces here even though the
 * default list (and every picker) hides it.
 */
const ARCHIVED_ORGANIZATIONS_SECTION_CONFIG: DashboardConfigV1_1 = {
  portlets: [
    {
      id: "archived-organizations-list",
      title: "Archived organizations",
      w: 12,
      h: 10,
      x: 0,
      y: 0,
      analysisConfig: {
        version: 1,
        analysisType: "query",
        activeView: "table",
        charts: {
          query: {
            chartType: "cinatraLinkedTable",
            chartConfig: {},
            displayConfig: {},
          },
        },
        query: {
          measures: ["organizations.member_count"],
          dimensions: [
            "organizations.id",
            "organizations.name",
            "organizations.role",
            "organizations.team_names",
          ],
          filters: [
            { member: "organizations.lifecycle_status", operator: "equals", values: ["archived"] },
          ],
          order: { "organizations.name": "asc" },
          limit: 500,
        },
      },
    },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

/**
 * Whether the viewer is a member of at least one archived organization —
 * decides between the real fixed section and its empty-state.
 * Fail-closed-but-non-critical: an unreadable count degrades to the
 * empty-state (never a broken page for chrome that isn't the primary grid).
 */
async function viewerHasArchivedOrganizations(userId: string): Promise<boolean> {
  try {
    const rows = await betterAuthDb
      .select({ id: betterAuthOrganizations.id })
      .from(betterAuthMembers)
      .innerJoin(
        betterAuthOrganizations,
        eq(betterAuthMembers.organizationId, betterAuthOrganizations.id),
      )
      .where(
        and(
          eq(betterAuthMembers.userId, userId),
          isNotNull(betterAuthOrganizations.archivedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

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

  // cinatra#1942 V4 — decides between the real fixed Archived section and
  // its empty-state (shown only with at least one archived membership).
  const hasArchivedOrganizations = await viewerHasArchivedOrganizations(ctx.userId);

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

        {/* cinatra#1942 V4 — fixed, non-removable "Archived organizations"
            chrome, OUTSIDE the editable grid above: a plain server-rendered
            section, never part of the saved/editable DC config, so there is
            no remove/edit affordance to strip away. */}
        <section
          data-cinatra-archived-organizations-section="true"
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold text-foreground">
              Archived organizations
            </h2>
            <p className="text-sm text-muted-foreground">
              Read-only. Archived organizations still count toward any
              organization limit — they are not deleted.
            </p>
          </div>
          {hasArchivedOrganizations ? (
            <EmbeddedDrizzleCubeDashboardGrid
              dashboard={ARCHIVED_ORGANIZATIONS_SECTION_CONFIG}
              editable={false}
            />
          ) : (
            <p
              data-cinatra-archived-organizations-empty="true"
              className="text-sm text-muted-foreground"
            >
              You have no archived organizations.
            </p>
          )}
        </section>
      </PageContent>
    </Main>
  );
}
