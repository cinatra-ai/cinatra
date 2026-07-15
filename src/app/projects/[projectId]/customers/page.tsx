import { redirect } from "next/navigation";

// cinatra#1501: the Customers tab is folded into the Permissions tab as the
// "Guests" section (owner direction on PR #1619). This route survives only as
// a redirect so old links and bookmarks keep working.
type Props = { params: Promise<{ projectId: string }> };

export default async function ProjectCustomersRedirect({ params }: Props) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/permissions`);
}
