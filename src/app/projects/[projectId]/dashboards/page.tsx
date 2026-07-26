import "server-only";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { CrumbContributions } from "@/components/crumb-contributions";
import { requireActorContext } from "@/lib/auth-session";
import { projectsDb, projects } from "@/lib/projects-store";
import { EntityScopeTabs } from "@/components/entity-scope-tabs";
import { ScopeDashboardsSection } from "@/components/dashboards/scope-dashboards-section";

type Props = { params: Promise<{ projectId: string }> };

/**
 * The PROJECT entity page's Dashboards tab (cinatra#1897 B4; the ratified design
 * spec at design@0ead5d0c5 §IX). The page IS the entity — h1 = the project name +
 * kind label, with the canonical underline tablist (Dashboards · Settings)
 * beneath (Settings mounts the existing `/projects/[projectId]/settings`
 * surface). Mounts at `/projects/[projectId]/dashboards`, alongside
 * the project-detail dashboards shell (#706) — a dedicated scope-collection
 * route. View is gated to a member of the project's sealed room (any project
 * grant); Add/Remove are gated to a project admin/owner (§IX.2). A PROJECT tab
 * has NO promotion recourse (a project is a resource refinement, not a visibility
 * tier — the contract yields a null recourse there).
 */
export default async function ProjectScopeDashboardsPage({ params }: Props) {
  const { projectId } = await params;
  const actor = await requireActorContext();

  const rows = await projectsDb
    .select({
      id: projects.id,
      name: projects.name,
      organizationId: projects.organizationId,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const project = rows[0];
  if (!project || !project.organizationId) notFound();

  // View gate: a member of the project's sealed room — the actor holds a grant
  // for THIS project (any role). Non-members are redirected (fail-closed).
  const grants = actor.projectGrants ?? [];
  if (!grants.some((g) => g.projectId === project.id)) {
    redirect("/not-authorized");
  }

  const scope = {
    kind: "project" as const,
    scopeId: project.id,
    orgId: project.organizationId,
  };

  return (
    <Main className="min-h-screen">
      <CrumbContributions
        entries={[
          {
            prefix: `/projects/${encodeURIComponent(project.id)}`,
            label: project.name,
          },
          {
            prefix: `/projects/${encodeURIComponent(project.id)}/dashboards`,
            label: "Dashboards",
          },
        ]}
      />
      <PageHeader label="Project" title={project.name} divider={false} />
      <PageContent className="flex flex-col gap-5 pb-8">
        <EntityScopeTabs
          dashboardsHref={`/projects/${encodeURIComponent(project.id)}/dashboards`}
          settingsHref={`/projects/${encodeURIComponent(project.id)}/settings`}
          active="dashboards"
        />
        <ScopeDashboardsSection
          actor={actor}
          scope={scope}
          scopeLabel={`Project: ${project.name}`}
        />
      </PageContent>
    </Main>
  );
}
