/**
 * `/organizations/[id]` screen — per-org detail DC dashboard.
 *
 * Mirrors `organizations-dashboard.tsx` but renders a read-only DC dashboard
 * scoped to the single org via a same-cube `equals` filter (see
 * `entity-detail-config.ts`). A read/analytics surface — distinct from the
 * `/workspace` org-membership management surface.
 *
 * Authz: the redirect gate uses the session SecurityContext; the cube DATA is
 * scoped by the cubejs route (`WHERE id IN (accessibleOrgIds)`) intersected
 * with the `organizations.id = id` filter — an inaccessible org yields zero
 * rows (fail closed).
 */
import "server-only";
import { redirect } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";

import { getAuthSession } from "@/lib/auth-session";

import { buildSecurityContextFromSession } from "../auth/security-context";
import { DashboardGridContainer } from "../components/dashboard-grid-container";
import { DashboardsClientShell } from "../components/dashboards-client-shell";
import { buildOrganizationDetailConfig } from "../components/seed-configs/entity-detail-config";

export async function OrganizationDetailDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect("/sign-in");
  }

  const initialConfig = buildOrganizationDetailConfig(id);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Organization"
        description="Organization overview."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <DashboardsClientShell>
          <DashboardGridContainer initialConfig={initialConfig} editable={false} />
        </DashboardsClientShell>
      </PageContent>
    </Main>
  );
}
