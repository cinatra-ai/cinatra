import type { Metadata } from "next";

import {
  DashboardDetailScreen,
  dashboardDetailMetadata,
} from "@/app/dashboards/[id]/dashboard-detail-screen";
import { decodeDashboardRouteSegment } from "@/lib/dashboards/dashboard-route-segment";

type Props = { params: Promise<{ teamId: string; dashboardId: string }> };

// The address is read ONCE, here. The framework hands a dynamic segment to a
// page percent-escaped whichever form the address took, while the store holds
// the plain identifier, so every step below works on the decoded one: the
// anchor comparison the shared screen makes, the lookup, the access check and
// the path this page reports it is serving.
const read = ({ teamId, dashboardId }: { teamId: string; dashboardId: string }) => ({
  teamId: decodeDashboardRouteSegment(teamId),
  dashboardId: decodeDashboardRouteSegment(dashboardId),
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { teamId, dashboardId } = read(await params);
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
  const { teamId, dashboardId } = read(await params);
  return (
    <DashboardDetailScreen
      id={dashboardId}
      currentPath={`/teams/${encodeURIComponent(teamId)}/dashboards/${encodeURIComponent(dashboardId)}`}
      expectedAnchor={{ entityType: "team", entityId: teamId }}
    />
  );
}
