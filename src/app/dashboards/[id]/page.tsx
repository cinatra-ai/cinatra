import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import { buildDashboardActorFromSession } from "@/lib/dashboards/dashboard-actor";
import { requireDashboardAccess, DashboardAccessError } from "@/lib/dashboards/authz";
import { readDashboardRowById, isProjectTemplate } from "@cinatra-ai/dashboards/extension-dashboard-reads";
import { validateDashboardConfigV12 } from "@cinatra-ai/dashboards/extension-materialization";
import { PortletHost, type PortletInstanceProp } from "@/components/dashboards/portlet-host";

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

  const parsed = validateDashboardConfigV12(row.configJson);
  const portlets: PortletInstanceProp[] = parsed.ok ? (parsed.config.portlets as unknown as PortletInstanceProp[]) : [];
  const rowContext: Record<string, unknown> = {
    projectId: row.projectId,
    organizationId: row.organizationId,
    ownerLevel: row.ownerLevel,
    ownerId: row.ownerId,
    scopeLevel: row.templateScope,
  };

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={row.name}
        description={row.description ?? undefined}
        actions={<ScopeBadge level={row.ownerLevel as ScopeLevel} />}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {!parsed.ok ? (
          <Card className="border-line bg-surface backdrop-blur-none">
            <CardHeader>
              <CardTitle>Unsupported dashboard format</CardTitle>
              <CardDescription>
                This dashboard is not an extension v1.2 dashboard; its portlets cannot be rendered here.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <PortletHost portlets={portlets} rowContext={rowContext} />
        )}
      </PageContent>
    </Main>
  );
}
