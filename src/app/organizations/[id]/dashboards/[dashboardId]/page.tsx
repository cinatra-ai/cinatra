import type { Metadata } from "next";

import {
  DashboardDetailScreen,
  dashboardDetailMetadata,
} from "@/app/dashboards/[id]/dashboard-detail-screen";

type Props = { params: Promise<{ id: string; dashboardId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, dashboardId } = await params;
  return dashboardDetailMetadata(dashboardId, {
    entityType: "organization",
    entityId: id,
  });
}

// Canonical home of an ORGANIZATION-anchored dashboard (cinatra#1738 D2). The
// shared screen 404s when the row's own anchor does not match this org.
export default async function OrganizationDashboardDetailPage({ params }: Props) {
  const { id, dashboardId } = await params;
  return (
    <DashboardDetailScreen
      id={dashboardId}
      currentPath={`/organizations/${encodeURIComponent(id)}/dashboards/${encodeURIComponent(dashboardId)}`}
      expectedAnchor={{ entityType: "organization", entityId: id }}
    />
  );
}
