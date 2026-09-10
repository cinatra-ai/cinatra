import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { eq, sql } from "drizzle-orm";

import * as authSession from "@/lib/auth-session";
const { requireActorContext } = authSession;
import { projectsDb, projects } from "@/lib/projects-store";
import { readScopeSurfaceEntityName } from "@/lib/scope-surface-entity-name";
import { CrumbContributions } from "@/components/crumb-contributions";
import { actorHoldsProjectGrant } from "@/lib/authz/project-read-gate";


import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { EntityScopeTabs } from "@/components/entity-scope-tabs";
import { LifecycleBadge } from "@/components/lifecycle-badge";
import { ScopeDashboardsSection } from "@/components/dashboards/scope-dashboards-section";
import { ScopeAddSourcesProvider } from "@/components/dashboards/scope-add-sources";
import { buildScopeReferenceSource } from "@/components/dashboards/scope-reference-binding";
import { buildScopeCatalogNode } from "@/components/dashboards/scope-catalog-node";

// Gate-repeating metadata (cinatra#1737, the dashboards pattern): the tab
// title repeats the page's read gate before disclosing the project name; any
// failure yields the generic title. The gate and the read live in ONE place
// (cinatra#2807 fix leg 2) so this tab title and the page heading beneath it
// can never disagree about what the viewer may be told.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectId } = await params;
  const name = await readScopeSurfaceEntityName({ kind: "project", id: projectId });
  return { title: name || "Project" };
}

type Props = {
  params: Promise<{ projectId: string }>;
};

// ---------------------------------------------------------------------------
// `/projects/[projectId]` detail page (cinatra#706, tabless since #1733).
//
// Project is NEVER an ownership tier — there is no promotion path between
// tiers. Access is N:M via `project_access`. The detail page is a Dashboards
// surface:
//   1. PageHeader with the "Project" scope label, ScopeBadge for owner level,
//      and an Archived badge when `projects.archived_at IS NOT NULL`, followed
//      by the entity-page tablist (cinatra#2474 PR1, spec §IX) — this page IS
//      the Dashboards tab, Settings is the second entry (the former top-right
//      settings button is gone). Management (ownership, access
//      grants, guest grants) lives on `/projects/[projectId]/settings` (#1733,
//      the #1693 teams ruling: one settings surface, no Permissions tab).
//   2. The Dashboards tab body the ratified drawing gives it (cinatra#2807 fix
//      leg 3): the caption "The dashboards in Project: <name>." over the
//      scope's rows, with "Add dashboard" at the right of that caption row for
//      a project manager only. The dashboard CANVAS this landing used to stack
//      above that panel — a toolbar band, an Overview selector, a project
//      details card with the raw identifier, and a sealed-room counts card — is
//      gone: the section names none of them, the Components Toolbar rule
//      forbids the band's placement ("never stack a toolbar and the etched
//      paired rule"), and identity belongs to the Settings pane, "where rename,
//      visibility and the members / access section live folded together". Each
//      dashboard opens at its canonical surface — "the tab points, it never
//      renders a dashboard inline".
//
// The legacy /customers and /agents routes + their nav buttons were removed in
// the #707 cleanup slice (customers folded into the permissions Guests section
// in #1640; /customers 404s with no redirect).
// ---------------------------------------------------------------------------

export default async function ProjectDetailPage({ params }: Props) {
  const actor = await requireActorContext();
  const { projectId } = await params;

  // (1) Load the project row. `archived_at` lives outside the Drizzle
  // binding, so pull it via a raw SQL fragment appended to the Drizzle select.
  const rows = await projectsDb
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const project = rows[0];
  if (!project) notFound();

  const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');

  // archived_at not in the Drizzle binding — read it explicitly.
  const archivedResult = await projectsDb.execute<{ archived_at: Date | null }>(sql`
    SELECT archived_at FROM "${sql.raw(schema)}"."projects" WHERE id = ${project.id}
  `);
  const archivedAt = archivedResult.rows[0]?.archived_at ?? null;

  // (2) Sealed-room read gate (#1898). Access is N:M via `project_access`; the
  // actor must hold a resolved project grant for THIS project (owned ∪
  // accessed). `requireActorContext` populates the canonical `projectGrants`
  // axis via `readProjectGrantsForUser` (Source 1 implicit-owned incl.
  // org-owned member read, Source 2 explicit user/team/org grants, Source 3
  // co-owner). 404-hide on a miss so existence is never leaked. This is the
  // SAME resolved-grant source this landing's own Dashboards tab, the `/projects`
  // cube, and the `/artifacts` project dashboard gate on — NOT the kernel
  // `can(project.read)` path, whose `member` role would grant blanket org-wide
  // read and defeat the sealed room.
  const userId = actor.principalId;
  if (!actorHoldsProjectGrant(actor, project.id)) {
    notFound();
  }

  const isArchived = archivedAt !== null;

  // The §IX.1 add-to-scope source for the unified Add-dashboard popup
  // (cinatra#2474 PR3). `null` for anyone who may not write this project's
  // collection (a project admin/owner grant, §IX.2) — suppression at the source,
  // so a read-only member's browser never receives the add actions. Guarded on
  // `organizationId` for the same reason the panel is: the listing scope is
  // tenant-anchored, and a project without one has no scope to add to.
  const scopeReference = project.organizationId
    ? buildScopeReferenceSource(actor, {
        kind: "project",
        scopeId: project.id,
        orgId: project.organizationId,
      })
    : null;
  const scopeLabel = `Project: ${project.name}`;

  // NOTE (fix leg 3, convergence round): the popup's create and installed-catalog
  // paths are NOT wired from this landing. Both write a row owned by the acting
  // user, and this tab reads the SCOPE's collection, so a copy made through them
  // would report success and then appear nowhere here. The drawn Add is the
  // add-to-scope picker; where the other two belong is recorded on the pull
  // request for the maintainer.

  // Concept B's installed-catalog section (cinatra#2474 PR4). Guarded on
  // `organizationId` exactly as the reference source is — a project without a
  // tenant has no org whose installs could be read, and the catalog's own tenant
  // fence would refuse it anyway; refusing here keeps the two paths identical.
  const catalog = project.organizationId
    ? await buildScopeCatalogNode({
        actor,
        surface: {
          kind: "project",
          orgId: project.organizationId,
          scopeId: project.id,
          userId,
        },
      })
    : null;

  return (
    <Main className="min-h-screen">
      {/* Post-gate crumb publisher (cinatra#1737). */}
      <CrumbContributions
        entries={[
          { prefix: `/projects/${encodeURIComponent(project.id)}`, label: project.name },
        ]}
      />
      <PageHeader
        label="Project"
        title={project.name}
        description="Bounded work context where agents run, project-specific capabilities are reused, data is created, approvals happen, and outputs accumulate."
        actions={isArchived ? <LifecycleBadge status="archived" /> : undefined}
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* The entity-page tablist (cinatra#2474 PR1, spec §IX): this landing IS
            the Dashboards tab; Settings is the second entry. Rendered for every
            reader — the settings page owns the read-only/manage split. */}
        <EntityScopeTabs
          dashboardsHref={`/projects/${encodeURIComponent(project.id)}`}
          assistantsHref={`/projects/${encodeURIComponent(project.id)}/assistants`}
          agentsHref={`/projects/${encodeURIComponent(project.id)}/agents`}
          artifactsHref={`/projects/${encodeURIComponent(project.id)}/artifacts`}
          skillsHref={`/projects/${encodeURIComponent(project.id)}/skills`}
          settingsHref={`/projects/${encodeURIComponent(project.id)}/settings`}
          active="dashboards"
        />
        {isArchived && (
          <div className="soft-panel border-line bg-surface-muted px-4 py-3 text-xs text-muted-foreground">
            This project was archived
            {archivedAt ? ` on ${format(archivedAt, "MMM d, yyyy")}` : ""}.
            It is read-only — writes (new objects, agent runs, binding mutations) are
            rejected by <code>assertProjectWritable</code>. Use the project access
            controls to unarchive if you have admin role.
          </div>
        )}

        {/* The Dashboards tab body. Guarded on `organizationId`: the listing
            scope is tenant-anchored (`dashboard_entity_links.organization_id`),
            and the retired collection route 404'd a project without one. A
            landing must not 404 for that, so the body is simply absent — never
            mounted against a forged tenant. */}
        {project.organizationId ? (
          <ScopeAddSourcesProvider
            scopeLabel={scopeLabel}
            reference={scopeReference}
            catalog={catalog}
          >
            <ScopeDashboardsSection
              actor={actor}
              scope={{
                kind: "project",
                scopeId: project.id,
                orgId: project.organizationId,
              }}
              entityLabel={scopeLabel}
            />
          </ScopeAddSourcesProvider>
        ) : null}
      </PageContent>
    </Main>
  );
}
