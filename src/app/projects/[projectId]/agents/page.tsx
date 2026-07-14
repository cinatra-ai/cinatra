import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireAuthSession } from "@/lib/auth-session";
import { readProjectById } from "@/lib/projects-store-dao";
import { readProjectCoOwners } from "@/lib/project-co-owners-store";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
import { readAgentsForSkillMatching } from "@/lib/agents-store";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { ProjectSubnav } from "@/components/project-subnav";

import {
  ProjectAgentBindingsClient,
  type ProjectAgentTemplateBindingView,
} from "./bindings-client";
import { AddAgentHeaderButton, BindPanelProvider } from "./bind-panel-context";
import { listProjectAgentTemplateBindingsAction } from "./actions";

export const metadata: Metadata = { title: "Project agents" };

type Props = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ bindTemplate?: string | string[] }>;
};

// ---------------------------------------------------------------------------
// `/projects/[projectId]/agents` route.
//
// Project-scoped management of agent template bindings backed by
// `project_agent_template_bindings_*` primitives. Agent templates
// themselves stay ambient because substrate templates are excluded from
// project-specific ownership.
//
// cinatra#1503: bound rows are enriched server-side with the resolved
// template display name (ONE batched catalog read — no per-row lookups), the
// header exposes an "Add agent" action for editors, and a
// `?bindTemplate=<id>` deep link preselects a template in the bind picker
// (the create-agent return path — one explicit Bind click, never auto-bind).
// ---------------------------------------------------------------------------

export default async function ProjectAgentsPage({ params, searchParams }: Props) {
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

  let bindings: ProjectAgentTemplateBindingView[] = [];
  const result = await listProjectAgentTemplateBindingsAction(project.id);

  // canEdit mirrors the permissions page heuristic — the underlying
  // create/update/delete handlers reject when the actor lacks the `write`
  // grant, so this is purely a UX hint. Platform admin + project owner
  // always pass.
  const userId = actor.userId ?? null;
  const isAdmin = (actor as unknown as { platformRole?: string }).platformRole
    === "platform_admin";
  const canEdit = isAdmin || project.ownerId === userId;

  // ?bindTemplate=<id> deep link (§4.4 return/preselect): preselect the
  // template in the bind picker for editors only. Display-name resolution
  // happens server-side, from the same catalog map as the bound rows; an
  // unlisted id keeps a null name and renders via the "Unknown template"
  // fallback.
  const { bindTemplate } = await searchParams;
  const preselectId =
    canEdit && typeof bindTemplate === "string" && bindTemplate.trim().length > 0
      ? bindTemplate.trim()
      : null;

  // Resolve template display names in ONE batched catalog read (the same
  // installed-agents reader the bind picker's candidate action uses, so names
  // and candidates can never drift). Skipped entirely when nothing needs a
  // name (no bound rows and no preselect — e.g. a degraded bindings read);
  // the reader is defensive by default, so a failed read degrades every name
  // to the "Unknown template" fallback.
  const templateNameById = new Map<string, string>();
  if ((result.ok && result.items.length > 0) || preselectId !== null) {
    const installed = await readAgentsForSkillMatching();
    for (const agent of installed) {
      if (agent.packageId) {
        templateNameById.set(agent.packageId, agent.humanReadableName);
      }
    }
  }
  if (result.ok) {
    bindings = result.items.map((b) => ({
      ...b,
      templateName: templateNameById.get(b.agentTemplateId) ?? null,
    }));
  }
  const initialTemplate = preselectId
    ? { id: preselectId, name: templateNameById.get(preselectId) ?? null }
    : null;

  return (
    <Main className="min-h-screen">
      <BindPanelProvider initialOpen={initialTemplate !== null}>
        <PageHeader
          title={project.name}
          description="Pin agent templates to this project. Templates stay ambient; bindings curate which agents appear, optional pinned versions, and per-project context overrides."
          actions={canEdit ? <AddAgentHeaderButton /> : undefined}
          divider={false}
        />
        <ProjectSubnav projectId={project.id} activeSection="agents" />
        <PageContent className="flex flex-col gap-6 pb-8">
          <ProjectAgentBindingsClient
            projectId={project.id}
            canEdit={canEdit}
            bindings={bindings}
            initialTemplate={initialTemplate}
          />
        </PageContent>
      </BindPanelProvider>
    </Main>
  );
}
