import type { Metadata } from "next";
import Link from "next/link";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { buildDashboardActorFromSession } from "@/lib/dashboards/dashboard-actor";
import { filterReadableDashboards } from "@/lib/dashboards/authz";
import { listOrgDashboardRows, excludeProjectTemplates } from "@cinatra-ai/dashboards/extension-dashboard-reads";

export const metadata: Metadata = { title: "Dashboards" };

// Operator-facing list of dashboards visible to the actor.
// Excludes project-scope TEMPLATE rows (only their per-project instances render);
// owner + project-grant filtering via filterReadableDashboards.
export default async function DashboardsPage() {
  const { actor, orgId } = await buildDashboardActorFromSession();
  const rows = orgId ? filterReadableDashboards(excludeProjectTemplates(await listOrgDashboardRows(orgId)), actor) : [];

  return (
    <Main className="min-h-screen">
      <PageHeader title="Dashboards" description="Operator workspaces composed from extension-shipped portlets." />
      <PageContent className="flex flex-col gap-6 pb-8">
        {rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No dashboards yet</EmptyTitle>
              <EmptyDescription>
                Install a workflow extension that ships a dashboard, or one scoped to a project you can access.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((row) => (
              <Link
                key={row.id}
                href={`/dashboards/${row.id}`}
                className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <Card className="border-line bg-surface-strong backdrop-blur-none transition-colors hover:bg-surface-muted">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                      <CardTitle>{row.name}</CardTitle>
                      <ScopeBadge level={row.ownerLevel as ScopeLevel} />
                    </div>
                    {row.description && <CardDescription>{row.description}</CardDescription>}
                  </CardHeader>
                  <CardContent>
                    <p className="font-mono text-xs text-muted-foreground">{row.extensionId ?? "operator-authored"}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </PageContent>
    </Main>
  );
}
