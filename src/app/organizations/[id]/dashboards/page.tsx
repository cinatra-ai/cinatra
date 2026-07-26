import "server-only";
import { notFound, redirect } from "next/navigation";
import { sql } from "drizzle-orm";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { CrumbContributions } from "@/components/crumb-contributions";
import { requireAuthSession, requireActorContext } from "@/lib/auth-session";
import { betterAuthDb } from "@/lib/better-auth-db";
import { EntityScopeTabs } from "@/components/entity-scope-tabs";
import { ScopeDashboardsSection } from "@/components/dashboards/scope-dashboards-section";

type Props = { params: Promise<{ id: string }> };

/**
 * The ORGANIZATION entity page's Dashboards tab (cinatra#1897 B4; the ratified
 * design spec at design@0ead5d0c5 §IX). The page IS the entity — h1 = the org
 * name + kind label, with the canonical underline tablist (Dashboards · Settings)
 * beneath (Settings mounts the existing `/organizations/[id]/settings` surface).
 * Mounts at `/organizations/[id]/dashboards` (the dedicated scope-collection
 * route, previously a bare crumb redirect, cinatra#1738 D2), leaving the
 * org-detail dashboards shell untouched. Read is universal for org members;
 * Add/Remove are gated to an org owner/admin (§IX.2).
 */
export default async function OrganizationScopeDashboardsPage({ params }: Props) {
  const { id } = await params;
  const session = await requireAuthSession();
  const actor = await requireActorContext();

  // View gate + tenant fence: the org must be the actor's active org (an org
  // member views; a non-member is redirected). The org-scope reads run under the
  // active org.
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  if (activeOrgId !== id || actor.organizationId !== id) {
    redirect("/not-authorized");
  }

  const rows = await betterAuthDb.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM public."organization" WHERE id = ${id} LIMIT 1
  `);
  const org = rows.rows?.[0];
  if (!org) notFound();

  const scope = { kind: "organization" as const, scopeId: org.id, orgId: org.id };

  return (
    <Main className="min-h-screen">
      <CrumbContributions
        entries={[
          {
            prefix: `/organizations/${encodeURIComponent(org.id)}`,
            label: org.name,
          },
          {
            prefix: `/organizations/${encodeURIComponent(org.id)}/dashboards`,
            label: "Dashboards",
          },
        ]}
      />
      <PageHeader label="Organization" title={org.name} divider={false} />
      <PageContent className="flex flex-col gap-5 pb-8">
        <EntityScopeTabs
          dashboardsHref={`/organizations/${encodeURIComponent(org.id)}/dashboards`}
          settingsHref={`/organizations/${encodeURIComponent(org.id)}/settings`}
          active="dashboards"
        />
        <ScopeDashboardsSection
          actor={actor}
          scope={scope}
          scopeLabel={`Organization: ${org.name}`}
        />
      </PageContent>
    </Main>
  );
}
