import type { Metadata } from "next";

import {
  DashboardDetailScreen,
  dashboardDetailMetadata,
} from "@/app/dashboards/[id]/dashboard-detail-screen";
import { decodeDashboardRouteSegment } from "@/lib/dashboards/dashboard-route-segment";

type Props = { params: Promise<{ id: string; dashboardId: string }> };

// The address is read ONCE, here, for the same reason the team route does it:
// the framework hands a dynamic segment to a page percent-escaped whichever
// form the address took, while the store holds the plain identifier.
const read = ({ id, dashboardId }: { id: string; dashboardId: string }) => ({
  id: decodeDashboardRouteSegment(id),
  dashboardId: decodeDashboardRouteSegment(dashboardId),
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, dashboardId } = read(await params);
  return dashboardDetailMetadata(dashboardId, {
    entityType: "organization",
    entityId: id,
  });
}

// Canonical home of an ORGANIZATION-anchored dashboard (cinatra#1738 D2). The
// shared screen 404s when the row's own anchor does not match this org.
export default async function OrganizationDashboardDetailPage({ params }: Props) {
  const { id, dashboardId } = read(await params);
  return (
    <DashboardDetailScreen
      id={dashboardId}
      currentPath={`/organizations/${encodeURIComponent(id)}/dashboards/${encodeURIComponent(dashboardId)}`}
      expectedAnchor={{ entityType: "organization", entityId: id }}
    />
  );
}
