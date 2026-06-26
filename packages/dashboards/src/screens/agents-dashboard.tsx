/**
 * /agents screen.
 *
 * Renders a real drizzle-cube dashboard (composable pieces + the
 * Cinatra-owned toolbar) themed to shadcn tokens. The page is a server
 * component that:
 *
 *   1. Resolves the better-auth session -> Cinatra SecurityContext.
 *      Unauthenticated callers get a redirect to /sign-in.
 *   2. Reads the seeded `system-agents-default` dashboard from the DB
 *      via the dashboards store. If missing, mounts AGENTS_DEFAULT_CONFIG
 *      directly - first save materializes the row via
 *      upsertDashboardConfig.
 *   3. Mounts the apiVersion 1.2 `<AnalyticsPortletView>` (the single
 *      PortletHost analytics-grid renderer) editable, threading the same page
 *      anchor + Grid/Rows modes + save action the legacy grid used (#328).
 *
 * Page chrome lives inside Cinatra's standard `<Main>` + `<PageHeader>`
 * + `<PageContent>` shell.
 */
import "server-only";
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq, desc } from "drizzle-orm";
import { agentTemplates } from "@cinatra-ai/agents/schema";
import { Play, Plus } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

import { getAuthSession } from "@/lib/auth-session";

import { buildSecurityContextFromSession } from "../auth/security-context";
import { and } from "drizzle-orm";

import { dashboards, getDashboardsDb } from "../store/db";
import { type DashboardConfigV1_1 } from "../store/dashboard-config";
import { readDcConfigFromRow } from "../v12-envelope";
import {
  AGENTS_DEFAULT_CONFIG,
  buildAgentsDashboardId,
} from "../components/seed-configs/agents-default";
import { AnalyticsPortletView } from "../components/analytics-portlet-view";
import { saveAgentsDashboardAction } from "../actions";

/**
 * Read the user's /agents layout with defense-in-depth actor filtering.
 *
 * Filters by id AND organizationId AND ownerId so that even if some other
 * MCP/server path pre-created a row with the matching composite id under a
 * DIFFERENT actor (cross-user/cross-org pre-poisoning attack), this read
 * does NOT pick it up. The mismatched row is treated as missing and we
 * render the seed.
 *
 * This is belt-and-braces alongside the schema-level prefix reservation
 * for `system-*` ids in mcp/schemas.ts.
 */
async function loadAgentsConfig(
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
  // Resolve the bare drizzle-cube config the grid mounts. After cinatra#326 the
  // persisted row is an apiVersion 1.2 analytics envelope, so unwrap the embedded
  // `config.dashboard` (an absent / corrupt / mislabeled / non-1.2 row falls
  // back to the seed — first save then materializes via upsertDashboardConfig;
  // the legacy 1.0/1.1 read path was removed in cinatra#329 after the migration).
  // #328 swapped the RENDER (now AnalyticsPortletView, the PortletHost grid
  // renderer) — the data shape stays the bare DC config the view mounts.
  return readDcConfigFromRow(existing, AGENTS_DEFAULT_CONFIG);
}

// Installed agent templates for this org. The dashboard portlets only chart
// agent_runs, so a fresh instance (0 runs) rendered blank even with templates
// installed (#307). This lists the installed agents so the page is meaningful
// before any run. Org-scoped (the same primary filter readAgentTemplates uses).
async function loadInstalledAgents(organizationId: string) {
  const db = getDashboardsDb();
  return db
    .select({
      id: agentTemplates.id,
      name: agentTemplates.name,
      description: agentTemplates.description,
      type: agentTemplates.type,
      status: agentTemplates.status,
    })
    .from(agentTemplates)
    .where(eq(agentTemplates.orgId, organizationId))
    .orderBy(desc(agentTemplates.createdAt))
    .limit(60);
}

export async function AgentsDashboardPage() {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect("/sign-in");
  }
  const dashboardId = buildAgentsDashboardId(ctx.organizationId, ctx.userId);
  const [initialConfig, installedAgents] = await Promise.all([
    loadAgentsConfig(dashboardId, ctx.organizationId, ctx.userId),
    loadInstalledAgents(ctx.organizationId),
  ]);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Agents"
        description="Top recently used and latest-run agent activity"
        divider={false}
        actions={
          /* Server-rendered SSR fallback so primary CTAs stay reachable
             until the client-side dashboard toolbar hydrates (it renders
             the same actions — see `cinatra-dashboard-toolbar.tsx`).
             `dashboard-theme.css` hides this block via a `body:has(...)`
             rule that keys on the LIVE presence of the toolbar's
             `[data-cinatra-page-action]` anchor. */
          <div
            data-cinatra-page-actions-fallback="agents"
            className="flex flex-wrap items-center gap-2"
          >
            <Button asChild>
              <Link href="/agents/run">
                <Play data-icon="inline-start" aria-hidden="true" />
                Run agent
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/chat?mode=create-agent">
                <Plus data-icon="inline-start" aria-hidden="true" />
                Create agent
              </Link>
            </Button>
          </div>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">
            Installed agents ({installedAgents.length})
          </h2>
          {installedAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No agents installed yet — create one above or install from the marketplace.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {installedAgents.map((a) => (
                <div key={a.id} className="rounded-panel border border-line bg-surface p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{a.name}</span>
                    <span className="shrink-0 rounded-control border border-line bg-surface-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {a.type}
                    </span>
                  </div>
                  {a.description ? (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.description}</p>
                  ) : null}
                  <div className="mt-2 text-xs text-muted-foreground">Status: {a.status}</div>
                </div>
              ))}
            </div>
          )}
        </section>
        <AnalyticsPortletView
          dashboard={initialConfig}
          editable
          onSave={saveAgentsDashboardAction}
          pageAnchor="agents"
          dashboardModes={["grid", "rows"]}
        />
      </PageContent>
    </Main>
  );
}
