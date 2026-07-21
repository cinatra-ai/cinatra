import { redirect } from "next/navigation";

type Props = { params: Promise<{ teamId: string }> };

// The team's dashboards live on the team detail page (its Dashboards tab) —
// this segment exists so the "Dashboards" crumb in a nested canonical URL
// (cinatra#1738 D2) is a real, navigable address rather than a 404.
export default async function TeamDashboardsIndexPage({ params }: Props) {
  const { teamId } = await params;
  redirect(`/teams/${encodeURIComponent(teamId)}`);
}
