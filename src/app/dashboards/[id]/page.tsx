import type { Metadata } from "next";

import {
  DashboardDetailScreen,
  dashboardDetailMetadata,
} from "./dashboard-detail-screen";
import { decodeDashboardRouteSegment } from "@/lib/dashboards/dashboard-route-segment";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return dashboardDetailMetadata(decodeDashboardRouteSegment(id));
}

// Flat dashboard detail. For a row anchored to a team/organization this route
// is NON-canonical — the shared screen redirects to the nested canonical URL
// (cinatra#1738 D2) after the access gates. Personal/workspace/legacy
// unanchored rows render here as before.
export default async function DashboardDetailPage({ params }: Props) {
  // Read ONCE, as the nested routes do: the framework hands a dynamic segment
  // to a page percent-escaped whichever form the address took, and this route
  // must reach the canonical redirect rather than answer not-found when a
  // punctuated identifier is typed here.
  const { id: idSegment } = await params;
  const id = decodeDashboardRouteSegment(idSegment);
  return (
    <DashboardDetailScreen
      id={id}
      currentPath={`/dashboards/${encodeURIComponent(id)}`}
    />
  );
}
