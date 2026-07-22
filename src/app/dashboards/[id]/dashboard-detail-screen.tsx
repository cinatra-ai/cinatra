import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import { buildDashboardActorFromSession } from "@/lib/dashboards/dashboard-actor";
import { requireDashboardAccess, DashboardAccessError } from "@/lib/dashboards/authz";
import { readOwnerDisplayName } from "@/lib/owner-display-names";
import { resolveLiveExtensionPredicate } from "@/lib/dashboards/live-extension-oracle";
// canonical-path has its OWN alias (not re-exported through the reads module):
// the reads module rides the MCP handlers into the locked API-route graphs,
// and the route-graph ratchet rightly rejects growing them with a module those
// routes never use.
import { canonicalDashboardPath } from "@cinatra-ai/dashboards/canonical-path";
import {
  readDashboardRowById,
  isProjectTemplate,
  isDashboardRowRenderable,
} from "@cinatra-ai/dashboards/extension-dashboard-reads";
import { validateDashboardConfigV12 } from "@cinatra-ai/dashboards/extension-materialization";
import { PortletHost, type PortletInstanceProp } from "@/components/dashboards/portlet-host";
import { CrumbContributions } from "@/components/crumb-contributions";

// Shared dashboard-detail screen (cinatra#1738): the flat /dashboards/[id]
// route AND the canonical nested routes (/teams/[teamId]/dashboards/[id],
// /organizations/[id]/dashboards/[id]) all render THIS component, so the
// gates, the canonical-URL redirect, and the render body exist exactly once.

/** The entity a nested route claims the dashboard belongs to. Ancestry may not
 *  be spoofed: the row's OWN anchor must match, else 404. */
export type DashboardAnchorExpectation = {
  readonly entityType: "team" | "organization";
  readonly entityId: string;
};

/** Metadata shared by every dashboard-detail route: gated behind the SAME
 *  checks as the page — never disclose a forbidden / cross-org /
 *  project-template dashboard's name via metadata, and never a name on a
 *  spoofed nested URL the page itself 404s (anchor parity). */
export async function dashboardDetailMetadata(
  id: string,
  expectedAnchor?: DashboardAnchorExpectation,
): Promise<Metadata> {
  try {
    const { actor } = await buildDashboardActorFromSession();
    const row = await readDashboardRowById(id);
    if (!row || isProjectTemplate(row)) return { title: "Dashboard" };
    // Same liveness/status gate as the page — never disclose an orphaned/archived
    // extension dashboard's name via metadata (cinatra#1628).
    const isPackageLive = await resolveLiveExtensionPredicate(row.organizationId);
    if (!isDashboardRowRenderable(row, isPackageLive)) return { title: "Dashboard" };
    if (
      expectedAnchor &&
      (row.entityType !== expectedAnchor.entityType ||
        row.entityId !== expectedAnchor.entityId)
    ) {
      return { title: "Dashboard" };
    }
    await requireDashboardAccess(actor, id, "read");
    return { title: row.name };
  } catch {
    return { title: "Dashboard" };
  }
}

export async function DashboardDetailScreen({
  id,
  currentPath,
  expectedAnchor,
}: {
  id: string;
  /** The encoded path this screen is being served at — compared against the
   *  canonical path AFTER every access gate, and used as the crumb prefix. */
  currentPath: string;
  expectedAnchor?: DashboardAnchorExpectation;
}) {
  const { actor } = await buildDashboardActorFromSession();

  const row = await readDashboardRowById(id);
  if (!row) notFound();
  // A project-scope template is a template only — 404 (dashboard_is_project_template).
  if (isProjectTemplate(row)) notFound();
  // ALL-READER liveness/status gate (cinatra#1628): an ARCHIVED row, or an
  // extension row whose extension is no longer installed+active (an orphan), 404s
  // here too — the by-id route has no status filter of its own, so a
  // bookmark/deep-link to a dead-package dashboard must be denied at read.
  const isPackageLive = await resolveLiveExtensionPredicate(row.organizationId);
  if (!isDashboardRowRenderable(row, isPackageLive)) notFound();

  // A nested URL must name the row's OWN anchor — a dashboard cannot be made
  // to claim foreign ancestry by crafting the URL (cinatra#1738).
  if (
    expectedAnchor &&
    (row.entityType !== expectedAnchor.entityType ||
      row.entityId !== expectedAnchor.entityId)
  ) {
    notFound();
  }

  try {
    await requireDashboardAccess(actor, id, "read");
  } catch (e) {
    if (e instanceof DashboardAccessError) notFound();
    throw e;
  }

  // One canonical URL per dashboard (cinatra#1738 D2): an anchored row lives
  // under its entity's route. The redirect runs only AFTER every gate above,
  // so an unauthorized caller learns nothing from it; redirect() is a 307, so
  // nothing is browser-cached permanently.
  const canonical = canonicalDashboardPath(row);
  if (canonical !== currentPath) redirect(canonical);

  // One dashboard format (apiVersion 1.2), one renderer (cinatra#329). apiVersion
  // 1.2 dashboards render via PortletHost — both extension dashboards AND (as of
  // cinatra#326) operator/agent dashboards, whose drizzle-cube config rides in an
  // `analytics` portlet that PortletHost renders as the full interactive grid.
  // The legacy 1.0.0/1.1.0 render branch was removed once all rows were migrated
  // to apiVersion 1.2 (cinatra#327); anything that does not validate as
  // apiVersion 1.2 falls through to the "unsupported format" card.
  const parsed = validateDashboardConfigV12(row.configJson);

  // Owner display name for the ScopeBadge (#1905) — best-effort, level-only
  // badge when unresolved.
  const ownerDisplayName = await readOwnerDisplayName(row.ownerLevel, row.ownerId);

  let body: ReactNode;
  if (parsed.ok) {
    const portlets = parsed.config.portlets as unknown as PortletInstanceProp[];
    const rowContext: Record<string, unknown> = {
      projectId: row.projectId,
      organizationId: row.organizationId,
      ownerLevel: row.ownerLevel,
      ownerId: row.ownerId,
      scopeLevel: row.templateScope,
    };
    body = <PortletHost portlets={portlets} rowContext={rowContext} />;
  } else {
    body = <UnsupportedFormatCard />;
  }

  return (
    <Main className="min-h-screen">
      {/* Post-gate crumb publisher (cinatra#1737): every gate above has
          passed, so the dashboard's name may reach the breadcrumb. */}
      <CrumbContributions entries={[{ prefix: currentPath, label: row.name }]} />
      <PageHeader
        title={row.name}
        description={row.description ?? undefined}
        actions={
          <ScopeBadge
            level={row.ownerLevel as ScopeLevel}
            ownerName={ownerDisplayName ?? undefined}
            aria-label={
              ownerDisplayName
                ? `Ownership: ${row.ownerLevel} — ${ownerDisplayName}`
                : `Ownership: ${row.ownerLevel}`
            }
          />
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">{body}</PageContent>
    </Main>
  );
}

function UnsupportedFormatCard() {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Unsupported dashboard format</CardTitle>
        <CardDescription>
          This dashboard uses an unrecognized config version; its portlets cannot be rendered here.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
