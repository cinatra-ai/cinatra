import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import { requireAuthSession } from "@/lib/auth-session";
import { readProjectById } from "@/lib/projects-store-dao";
import { readProjectCoOwners } from "@/lib/project-co-owners-store";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";

import { ProjectAgentBindingsClient } from "./bindings-client";
import {
  listProjectAgentTemplateBindingsAction,
  type ProjectAgentTemplateBinding,
} from "./actions";

export const metadata: Metadata = { title: "Project agents" };

type Props = {
  params: Promise<{ projectId: string }>;
};

// ---------------------------------------------------------------------------
// `/projects/[projectId]/agents` route.
//
// Project-scoped management of agent template bindings backed by
// `project_agent_template_bindings_*` primitives. Agent templates
// themselves stay ambient because substrate templates are excluded from
// project-specific ownership.
// ---------------------------------------------------------------------------

export default async function ProjectAgentsPage({ params }: Props) {
  const session = await requireAuthSession();
  const { projectId } = await params;
  const actor = actorFromSession(session);

  const project = await readProjectById(projectId);
  if (!project) notFound();

  const coOwners = await readProjectCoOwners(project.id);
  try {
    await enforceResourceAccess(
      {
        resourceType: "project",
        resourceId: project.id,
        organizationId: project.organizationId,
        ownerLevel: normalizeOwnerLevel(project.ownerLevel),
        ownerId: project.ownerId,
        visibility: null,
        coOwnerUserIds: coOwners.map((c) => c.userId),
      },
      actor,
      "project.read",
    );
  } catch (err) {
    if (err instanceof AuthzError) notFound();
    throw err;
  }

  let bindings: ProjectAgentTemplateBinding[] = [];
  const result = await listProjectAgentTemplateBindingsAction(project.id);
  if (result.ok) bindings = result.items;

  // canEdit mirrors the permissions page heuristic — the underlying
  // create/update/delete handlers reject when the actor lacks the `write`
  // grant, so this is purely a UX hint. Platform admin + project owner
  // always pass.
  const userId = actor.userId ?? null;
  const isAdmin = (actor as unknown as { platformRole?: string }).platformRole
    === "platform_admin";
  const canEdit = isAdmin || project.ownerId === userId;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={project.name}
        description="Pin agent templates to this project. Templates stay ambient; bindings curate which agents appear, optional pinned versions, and per-project context overrides."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${project.id}`}>Overview</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${project.id}/permissions`}>Permissions</Link>
            </Button>
          </div>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <ProjectAgentBindingsClient
          projectId={project.id}
          canEdit={canEdit}
          bindings={bindings}
        />
      </PageContent>
    </Main>
  );
}
