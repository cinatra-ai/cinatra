/**
 * /agents screen.
 *
 * Renders a real `<DashboardGrid>` from drizzle-cube/client themed to
 * shadcn tokens. The page is a server component that:
 *
 *   1. Resolves the better-auth session -> Cinatra SecurityContext.
 *      Unauthenticated callers get a redirect to /sign-in.
 *   2. Reads the seeded `system-agents-default` dashboard from the DB
 *      via the dashboards store. If missing, mounts AGENTS_DEFAULT_CONFIG
 *      directly - first save materializes the row via
 *      upsertDashboardConfig.
 *   3. Mounts <DashboardsClientShell> hosting <AgentsDashboardGrid>.
 *
 * Page chrome lives inside Cinatra's standard `<Main>` + `<PageHeader>`
 * + `<PageContent>` shell.
 */
import "server-only";
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { Play, Plus } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

import { getAuthSession } from "@/lib/auth-session";

import { buildSecurityContextFromSession } from "../auth/security-context";
import { and } from "drizzle-orm";

import { dashboards, getDashboardsDb } from "../store/db";
import {
  parseDashboardConfig,
  type DashboardConfigV1_1,
} from "../store/dashboard-config";
import {
  AGENTS_DEFAULT_CONFIG,
  buildAgentsDashboardId,
} from "../components/seed-configs/agents-default";
import { AgentsDashboardGrid } from "../components/agents-dashboard-grid";
import { DashboardsClientShell } from "../components/dashboards-client-shell";
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
  if (!existing) {
    // First-visit-after-deploy path (or a pre-poisoned row that didn't
    // match the caller's actor). Render the seed; first save materializes
    // via upsertDashboardConfig.
    return AGENTS_DEFAULT_CONFIG;
  }
  try {
    const parsed = parseDashboardConfig(existing.configVersion, existing.configJson);
    return parsed as DashboardConfigV1_1;
  } catch {
    // Defensive: if a future schema version slips in or the DB row is
    // corrupt, fall back to the seed rather than 500.
    return AGENTS_DEFAULT_CONFIG;
  }
}

export async function AgentsDashboardPage() {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect("/sign-in");
  }
  const dashboardId = buildAgentsDashboardId(ctx.organizationId, ctx.userId);
  const initialConfig = await loadAgentsConfig(
    dashboardId,
    ctx.organizationId,
    ctx.userId,
  );

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Agents"
        description="Top recently used and latest-run agent activity"
        divider={false}
        actions={
          /* Server-rendered SSR fallback so primary CTAs stay reachable
             when the polish hook has not yet (or never) injected the
             equivalent anchors into the DC toolbar. `dashboard-theme.css`
             hides this block via a `body:has(...)` rule that keys on the
             LIVE presence of an injected `[data-cinatra-page-action]`
             anchor — see `use-dashboard-toolbar-polish.ts`. */
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
        <DashboardsClientShell pageAnchor="agents" dashboardModes={["grid", "rows"]}>
          <AgentsDashboardGrid
            initialConfig={initialConfig}
            editable
            onSave={saveAgentsDashboardAction}
          />
        </DashboardsClientShell>
      </PageContent>
    </Main>
  );
}
