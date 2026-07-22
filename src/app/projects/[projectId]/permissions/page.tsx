import { redirect } from "next/navigation";

// ---------------------------------------------------------------------------
// `/projects/[projectId]/permissions` → `/projects/[projectId]/settings`
// (cinatra#1733). The standalone permissions page was absorbed into the
// single project-management surface, applying the #1693 teams ruling.
//
// PURE redirect stub (the `teams/[teamId]/dashboards` precedent): no session,
// no gate, no data loads — a redirect leaks nothing, and the settings page
// 404-hides on the same `project.read` check this page used to run. Keeping
// the address navigable also keeps old links and the breadcrumb segment
// working.
// ---------------------------------------------------------------------------

type Props = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectPermissionsRedirect({ params }: Props) {
  const { projectId } = await params;
  redirect(`/projects/${encodeURIComponent(projectId)}/settings`);
}
