import type { Metadata } from "next";

import {
  DashboardDetailScreen,
  dashboardDetailMetadata,
} from "@/app/dashboards/[id]/dashboard-detail-screen";

type Props = { params: Promise<{ teamId: string; dashboardId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { teamId, dashboardId } = await params;
  return dashboardDetailMetadata(dashboardId, {
    entityType: "team",
    entityId: teamId,
  });
}

// Canonical home of a TEAM-anchored dashboard (cinatra#1738 D2): the URL
// carries the ancestry, so the breadcrumb renders Teams > {team} > Dashboards
// > {name} with no special cases. The shared screen 404s when the row's own
// anchor does not match this team (no ancestry spoofing via URL).
export default async function TeamDashboardDetailPage({ params }: Props) {
  const { teamId, dashboardId } = await params;
  return (
    <DashboardDetailScreen
      id={dashboardId}
      currentPath={`/teams/${encodeURIComponent(teamId)}/dashboards/${encodeURIComponent(dashboardId)}`}
      expectedAnchor={{ entityType: "team", entityId: teamId }}
    />
  );
}
