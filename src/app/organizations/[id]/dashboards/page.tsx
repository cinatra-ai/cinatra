import { redirect } from "next/navigation";

type Props = { params: Promise<{ id: string }> };

// An organization's dashboards live on the org detail page — this segment
// exists so the "Dashboards" crumb in a nested canonical URL (cinatra#1738 D2)
// is a real, navigable address rather than a 404.
export default async function OrganizationDashboardsIndexPage({ params }: Props) {
  const { id } = await params;
  redirect(`/organizations/${encodeURIComponent(id)}`);
}
