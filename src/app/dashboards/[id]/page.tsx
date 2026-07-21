import type { Metadata } from "next";

import {
  DashboardDetailScreen,
  dashboardDetailMetadata,
} from "./dashboard-detail-screen";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return dashboardDetailMetadata(id);
}

// Flat dashboard detail. For a row anchored to a team/organization this route
// is NON-canonical — the shared screen redirects to the nested canonical URL
// (cinatra#1738 D2) after the access gates. Personal/workspace/legacy
// unanchored rows render here as before.
export default async function DashboardDetailPage({ params }: Props) {
  const { id } = await params;
  return (
    <DashboardDetailScreen
      id={id}
      currentPath={`/dashboards/${encodeURIComponent(id)}`}
    />
  );
}
