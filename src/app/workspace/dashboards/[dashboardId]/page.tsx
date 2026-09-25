import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";

import { buildWorkspaceOverviewConfig } from "@cinatra-ai/dashboards/overview-config";
import { ensureEntityOverviewAction } from "@cinatra-ai/dashboards/entity-dashboard-actions";
import {
  buildOverviewDashboardId,
  isWorkspaceDashboardRow,
  workspaceDashboardRef,
} from "@cinatra-ai/dashboards/entity-identity";
import { readDashboardRowById } from "@cinatra-ai/dashboards/extension-dashboard-reads";
import { validateDashboardConfigV12 } from "@cinatra-ai/dashboards/dashboard-config-v12";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CrumbContributions } from "@/components/crumb-contributions";
import { PortletHost, type PortletInstanceProp } from "@/components/dashboards/portlet-host";
import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import { buildDashboardActorFromSession } from "@/lib/dashboards/dashboard-actor";
import { decodeDashboardRouteSegment } from "@/lib/dashboards/dashboard-route-segment";
import { DashboardAccessError, requireDashboardAccess } from "@/lib/dashboards/authz";
import {
  buildWorkspaceViewer,
  readWorkspaceOverviewSummary,
} from "@/lib/dashboards/workspace-dashboards.server";

// A name is never disclosed through metadata: the page gates below decide.
export const metadata: Metadata = { title: "Dashboard" };

type Props = { params: Promise<{ dashboardId: string }> };

/**
 * The canonical surface of a WORKSPACE dashboard (cinatra#2811, per-scope
 * surfaces S5): the org-NULL '__workspace__' entity lives under the workspace
 * page, so its URL carries that ancestry, and this route renders it.
 *
 *   - It serves ONLY workspace rows, and only to their owner: an organization
 *     dashboard, another user's workspace dashboard and an unknown id are all
 *     not found alike (no existence leak). A user's own workspace dashboards
 *     stay private.
 *   - The non-removable Overview renders FRESH: the workspace Overview config
 *     (the instance's display name and namespace, and the viewer's counts over
 *     the workspace vantage) is built per request and never persisted, the same
 *     render-only contract every entity Overview keeps.
 *   - Any other workspace dashboard renders its stored config.
 */
export default async function WorkspaceDashboardPage({ params }: Props) {
  // The segment is read ONCE, here, and every step below works on the decoded
  // identifier: the comparison with the composed id, the lookup, the access
  // check and the current path this page builds. The framework hands the
  // segment escaped whichever form the address took, while the store holds the
  // plain identifier (see the helper for where the framework does it).
  const { dashboardId: dashboardIdSegment } = await params;
  const dashboardId = decodeDashboardRouteSegment(dashboardIdSegment);
  const session = await requireAuthSession();
  let row = await readDashboardRowById(dashboardId);

  // The shell's Overview is brought into being by the workspace TAB, which
  // ensures it before it lists it. This address can arrive first: a bookmark, a
  // second window, a link a person sends themselves. The drawing calls the
  // Overview the row the shell ALWAYS carries, so its own surface may not
  // depend on a tab render having happened. The ensure runs ONLY for the acting
  // person's own Overview, and the id it compares against is composed from the
  // session rather than read from the address, so no address can name a row
  // this creates or opens for anybody else. Every gate below still runs. A
  // store failure inside the ensure surfaces as a failure rather than as
  // not-found, which is the honest answer when the store cannot be read.
  if (!row) {
    const ownRef = workspaceDashboardRef(session.user.id);
    if (dashboardId === buildOverviewDashboardId(ownRef)) {
      await ensureEntityOverviewAction(ownRef);
      row = await readDashboardRowById(dashboardId);
    }
  }
  if (!row || !isWorkspaceDashboardRow(row)) notFound();

  const { actor } = await buildDashboardActorFromSession();
  try {
    await requireDashboardAccess(actor, dashboardId, "read");
  } catch (e) {
    if (e instanceof DashboardAccessError) notFound();
    throw e;
  }

  const rowContext: Record<string, unknown> = {
    projectId: null,
    organizationId: null,
    ownerLevel: row.ownerLevel,
    ownerId: row.ownerId,
    scopeLevel: "workspace",
  };
  let body: ReactNode;
  if (row.isDefault) {
    const viewer = await buildWorkspaceViewer({
      userId: session.user.id,
      platformAdmin: isPlatformAdmin(session),
      activeOrganizationId: session.session?.activeOrganizationId ?? null,
    });
    const config = buildWorkspaceOverviewConfig(await readWorkspaceOverviewSummary(viewer));
    body = (
      <PortletHost
        portlets={config.portlets as unknown as PortletInstanceProp[]}
        rowContext={rowContext}
      />
    );
  } else {
    const parsed = validateDashboardConfigV12(row.configJson);
    body = parsed.ok ? (
      <PortletHost
        portlets={parsed.config.portlets as unknown as PortletInstanceProp[]}
        rowContext={rowContext}
      />
    ) : (
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

  const currentPath = `/workspace/dashboards/${encodeURIComponent(dashboardId)}`;
  return (
    <Main className="min-h-screen">
      {/* Post-gate crumb publisher: every gate above has passed. The
          intermediate Dashboards crumb has no page of its own, so it reads as a
          plain label rather than a link to a missing route. */}
      <CrumbContributions
        entries={[
          { prefix: "/workspace", label: "Workspace" },
          { prefix: "/workspace/dashboards", label: "Dashboards", nonNavigable: true },
          { prefix: currentPath, label: row.name },
        ]}
      />
      <PageHeader
        label="Workspace"
        title={row.name}
        description={row.description ?? undefined}
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">{body}</PageContent>
    </Main>
  );
}
