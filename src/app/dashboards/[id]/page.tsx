import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import dynamic from "next/dynamic";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import { buildDashboardActorFromSession } from "@/lib/dashboards/dashboard-actor";
import { requireDashboardAccess, DashboardAccessError } from "@/lib/dashboards/authz";
import { readDashboardRowById, isProjectTemplate } from "@cinatra-ai/dashboards/extension-dashboard-reads";
import {
  resolveDashboardRenderKind,
  validateDashboardConfigV12,
  parseDashboardConfig,
  type DashboardConfigV1_1,
} from "@cinatra-ai/dashboards/extension-materialization";
import { PortletHost, type PortletInstanceProp } from "@/components/dashboards/portlet-host";

// Legacy (config_version 1.0.0/1.1.0) drizzle-cube grid. Loaded lazily and only
// reached on the legacy branch, so the apiVersion 1.2 (PortletHost) render path's client
// bundle is unaffected (cinatra#272).
const LegacyDashboardView = dynamic(() =>
  import("@/components/dashboards/legacy-dashboard-view").then((m) => m.LegacyDashboardView),
);

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  // Gate the title behind the SAME checks as the page — never disclose a
  // forbidden / cross-org / project-template dashboard's name via metadata.
  try {
    const { actor } = await buildDashboardActorFromSession();
    const row = await readDashboardRowById(id);
    if (!row || isProjectTemplate(row)) return { title: "Dashboard" };
    await requireDashboardAccess(actor, id, "read");
    return { title: row.name };
  } catch {
    return { title: "Dashboard" };
  }
}

// Dashboard detail. Project-scope TEMPLATE rows never render directly (only
// their per-project instances). Access via requireDashboardAccess. Portlets
// render via the typed registry; until kinds are registered they show a
// structured placeholder.
export default async function DashboardDetailPage({ params }: Props) {
  const { id } = await params;
  const { actor } = await buildDashboardActorFromSession();

  const row = await readDashboardRowById(id);
  if (!row) notFound();
  // A project-scope template is a template only — 404 (dashboard_is_project_template).
  if (isProjectTemplate(row)) notFound();

  try {
    await requireDashboardAccess(actor, id, "read");
  } catch (e) {
    if (e instanceof DashboardAccessError) notFound();
    throw e;
  }

  // Version-aware dispatch on the row's config_version (cinatra#272). apiVersion 1.2
  // extension dashboards render via PortletHost; legacy operator/agent
  // dashboards (config_version 1.0.0/1.1.0) render via the drizzle-cube grid —
  // the SAME path the /agents screen uses — so agent-created dashboards show
  // their real analytics portlets instead of the "unsupported format" card.
  // Genuinely unknown versions still fall through to that card.
  const renderKind = resolveDashboardRenderKind(row.configVersion, row.configJson);

  let body: ReactNode;
  if (renderKind === "v12") {
    const parsed = validateDashboardConfigV12(row.configJson);
    const portlets: PortletInstanceProp[] = parsed.ok
      ? (parsed.config.portlets as unknown as PortletInstanceProp[])
      : [];
    const rowContext: Record<string, unknown> = {
      projectId: row.projectId,
      organizationId: row.organizationId,
      ownerLevel: row.ownerLevel,
      ownerId: row.ownerId,
      scopeLevel: row.templateScope,
    };
    body = <PortletHost portlets={portlets} rowContext={rowContext} />;
  } else if (renderKind === "legacy") {
    // parseDashboardConfig already succeeded inside resolveDashboardRenderKind;
    // re-parse here to get the typed config for the grid. The cast to
    // DashboardConfigV1_1 mirrors the proven /agents screen path
    // (screens/agents-dashboard.tsx: `parsed as DashboardConfigV1_1`) — the
    // drizzle-cube grid tolerates a sparse legacy payload (renders degraded, not
    // a crash). If parsing somehow throws, degrade to the unsupported card
    // rather than 500.
    let legacyConfig: DashboardConfigV1_1 | null = null;
    try {
      legacyConfig = parseDashboardConfig(row.configVersion, row.configJson) as DashboardConfigV1_1;
    } catch {
      legacyConfig = null;
    }
    body = legacyConfig ? (
      <LegacyDashboardView config={legacyConfig} />
    ) : (
      <UnsupportedFormatCard />
    );
  } else {
    body = <UnsupportedFormatCard />;
  }

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={row.name}
        description={row.description ?? undefined}
        actions={<ScopeBadge level={row.ownerLevel as ScopeLevel} />}
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
