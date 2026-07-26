import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { eq, sql } from "drizzle-orm";
import { Settings } from "lucide-react";

import * as authSession from "@/lib/auth-session";
const { getActorContext, requireActorContext } = authSession;
import { projectsDb, projects } from "@/lib/projects-store";
import { betterAuthDb } from "@/lib/better-auth-db";
import { readOwnerDisplayName } from "@/lib/owner-display-names";
import { CrumbContributions } from "@/components/crumb-contributions";
import { actorHoldsProjectGrant } from "@/lib/authz/project-read-gate";
import { AuthzError } from "@/lib/authz/errors";

import { buildProjectOverviewConfig } from "@cinatra-ai/dashboards/overview-config";
import {
  ensureEntityOverviewAction,
  listEntityDashboardsAction,
  getEntityDashboardConfigAction,
  createEntityDashboardAction,
  renameEntityDashboardAction,
  deleteEntityDashboardAction,
  saveEntityDashboardConfigAction,
} from "@cinatra-ai/dashboards/entity-dashboard-actions";
import type { EntityDashboardsDataSource } from "@cinatra-ai/dashboards/entity-dashboards-contract";
import type { DashboardEntityRef } from "@cinatra-ai/dashboards/entity-identity";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import { LifecycleBadge } from "@/components/lifecycle-badge";
import type { PortletInstanceProp } from "@/components/dashboards/portlet-host";

import {
  ProjectDashboardsTab,
  type ProjectDashboardsTabProps,
} from "./project-dashboards-tab";

// Gate-repeating metadata (cinatra#1737, the dashboards pattern): the tab
// title repeats the page's read gate before disclosing the project name; any
// failure yields the generic title.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  try {
    // Non-throwing session read: requireAuthSession() redirects (throws
    // NEXT_REDIRECT), which this try/catch would swallow. No session → the
    // generic title; the page component itself still redirects.
    const session = await authSession.getAuthSession();
    if (!session) return { title: "Project" };
    const { projectId } = await params;
    const rows = await projectsDb
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const project = rows[0];
    if (!project) return { title: "Project" };
    // Sealed-room read gate (#1898): the caller must hold a resolved project
    // grant for THIS project. `getActorContext` resolves the canonical
    // `projectGrants` axis (owned ∪ accessed) via `readProjectGrantsForUser`.
    const actor = await getActorContext();
    if (!actor || !actorHoldsProjectGrant(actor, project.id)) {
      return { title: "Project" };
    }
    return { title: project.name };
  } catch {
    return { title: "Project" };
  }
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
//   1. PageHeader with ScopeBadge for owner level, an Archived badge when
//      `projects.archived_at IS NOT NULL`, and a "Project settings" button —
//      management (ownership, access grants, guest grants) lives on
//      `/projects/[projectId]/settings` (#1733, the #1693 teams ruling: one
//      settings surface, no Permissions tab).
//   2. The reusable entity Dashboards shell (#701) whose non-removable
//      "Overview" default renders this project's CURRENT info as render-only
//      portlets (#702): metadata (name / slug / id / owner / organization /
//      visibility / created / description) + sealed-room counts (objects,
//      agent runs, chat threads). Counts read directly from the same physical
//      columns the sealed-room list handlers query
//      (`*.project_id = $projectId`), so the numbers match what the sealed
//      room exposes through its tooling.
//
// The legacy /customers and /agents routes + their nav buttons were removed in
// the #707 cleanup slice (customers folded into the permissions Guests section
// in #1640; /customers 404s with no redirect).
// ---------------------------------------------------------------------------

const VALID_OWNER_LEVELS: ReadonlySet<string> = new Set([
  "user",
  "team",
  "organization",
  "workspace",
  "project",
]);

function assertOwnerLevel(value: string): ScopeLevel {
  if (!VALID_OWNER_LEVELS.has(value)) {
    throw new AuthzError({
      statusCode: 404,
      reason: "hidden",
      message: "Not found.",
    });
  }
  return value as ScopeLevel;
}

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
  // SAME resolved-grant source the `/dashboards` tab route, the `/projects`
  // cube, and the `/artifacts` project dashboard gate on — NOT the kernel
  // `can(project.read)` path, whose `member` role would grant blanket org-wide
  // read and defeat the sealed room.
  const userId = actor.principalId;
  if (!actorHoldsProjectGrant(actor, project.id)) {
    notFound();
  }

  const ownerLevel = assertOwnerLevel(project.ownerLevel);

  // (3) Sealed-room counts — match the SQL list handlers run.
  // Each query filters on the table's `project_id` column directly.
  // We deliberately run three lightweight COUNT(*) calls rather than a
  // UNION ALL: the indexes are partial `(project_id, created_at DESC)
  // WHERE project_id IS NOT NULL` on each table, so an index-only
  // scan covers each count.
  const [objectsCountRes, runsCountRes, threadsCountRes] = await Promise.all([
    projectsDb.execute<{ c: string }>(sql`
      SELECT COUNT(*)::text AS c FROM "${sql.raw(schema)}"."objects"
       WHERE project_id = ${project.id} AND deleted_at IS NULL
    `),
    projectsDb.execute<{ c: string }>(sql`
      SELECT COUNT(*)::text AS c FROM "${sql.raw(schema)}"."agent_runs"
       WHERE project_id = ${project.id}
    `),
    projectsDb.execute<{ c: string }>(sql`
      SELECT COUNT(*)::text AS c FROM "${sql.raw(schema)}"."assistant_threads"
       WHERE project_id = ${project.id} AND origin = 'legacy-chat'
    `),
  ]);
  const objectsCount = Number(objectsCountRes.rows[0]?.c ?? "0");
  const runsCount = Number(runsCountRes.rows[0]?.c ?? "0");
  const threadsCount = Number(threadsCountRes.rows[0]?.c ?? "0");

  // Owner + organization display names (best-effort — fall back to id on a
  // Better Auth outage so the page stays renderable). Owner-name resolution
  // is the shared #1905 helper (also feeds the ScopeBadge); the tenant-org
  // display name below is a separate concern (Overview portlet only).
  const ownerDisplayName = await readOwnerDisplayName(ownerLevel, project.ownerId);
  let orgDisplayName: string | null = null;
  try {
    if (project.organizationId) {
      const o = await betterAuthDb.execute<{ name: string }>(sql`
        SELECT name FROM public."organization" WHERE id = ${project.organizationId} LIMIT 1
      `);
      orgDisplayName = o.rows[0]?.name ?? null;
    }
  } catch {
    // Best-effort; leave the name null.
  }

  const isArchived = archivedAt !== null;

  // ── Dashboards tab wiring (#701 shell + #702 Overview) ───────────────────
  // Per-user dashboards for THIS project instance. The ref is derived
  // server-side and bound into each action (`.bind(null, ref)`), so it crosses
  // to the client Next-encrypted and the client never authors the owner axis;
  // `resolveDashboardAccess` re-derives read/write on every call regardless.
  const ref: DashboardEntityRef = {
    entityType: "project",
    entityId: project.id,
    ownerLevel: "user",
    ownerId: userId,
  };

  const dataSource: EntityDashboardsDataSource = {
    listDashboards: listEntityDashboardsAction.bind(null, ref),
    loadConfig: getEntityDashboardConfigAction.bind(null, ref),
    createDashboard: createEntityDashboardAction.bind(null, ref),
    renameDashboard: renameEntityDashboardAction.bind(null, ref),
    deleteDashboard: deleteEntityDashboardAction.bind(null, ref),
    saveDashboard: saveEntityDashboardConfigAction.bind(null, ref),
  };

  // The FRESH Overview content: this project's live metadata + sealed-room
  // counts, composed into render-only portlets. Rebuilt every request — never
  // persisted (the mutation service rejects render-only kinds), so it can never
  // serve a stale or authorization-obsolete summary.
  const overviewConfig = buildProjectOverviewConfig({
    name: project.name,
    slug: project.slug,
    id: project.id,
    owner: ownerDisplayName ?? project.ownerId,
    organizationName: orgDisplayName ?? project.organizationId ?? undefined,
    visibility: project.visibility === "discoverable" ? "Discoverable" : "Private",
    createdAt: format(project.createdAt, "MMM d, yyyy"),
    description: project.description ?? undefined,
    counts: [
      { label: "Objects", value: objectsCount },
      { label: "Agent runs", value: runsCount },
      { label: "Chat threads", value: threadsCount },
    ],
  });
  const overviewPortlets: PortletInstanceProp[] = overviewConfig.portlets.map((p) => ({
    instanceId: p.instanceId,
    kind: p.kind,
    version: p.version,
    slot: p.slot,
    config: p.config as Record<string, unknown>,
  }));

  // Best-effort SSR seed so the default (Overview) paints without a client
  // round-trip. Ensure the non-removable Overview row exists BEFORE listing (the
  // shell never seeds it). On any failure (e.g. no active org) fall through with
  // no seed — the shell then client-loads and surfaces its own loading/error
  // state — while the Overview portlets above are always available regardless.
  let dashboardsInitial: ProjectDashboardsTabProps["initialData"];
  try {
    await ensureEntityOverviewAction(ref);
    const list = await listEntityDashboardsAction(ref);
    const overview = list.dashboards.find((d) => d.isDefault) ?? list.dashboards[0];
    if (overview) {
      // The Overview's persisted config is an empty anchor — its rendered
      // content comes from `overviewPortlets`, not this — but the shell wants a
      // typed seed for the selected id, so read it through the confined action.
      const config = await getEntityDashboardConfigAction(ref, overview.id);
      dashboardsInitial = { list, selectedId: overview.id, config };
    }
  } catch {
    dashboardsInitial = undefined;
  }

  return (
    <Main className="min-h-screen">
      {/* Post-gate crumb publisher (cinatra#1737). */}
      <CrumbContributions
        entries={[
          { prefix: `/projects/${encodeURIComponent(project.id)}`, label: project.name },
        ]}
      />
      <PageHeader
        title={project.name}
        description="Bounded work context where agents run, project-specific capabilities are reused, data is created, approvals happen, and outputs accumulate."
        actions={
          <div className="flex items-center gap-2">
            {isArchived && <LifecycleBadge status="archived" />}
            <ScopeBadge
              level={ownerLevel}
              ownerName={ownerDisplayName ?? undefined}
              aria-label={
                ownerDisplayName
                  ? `Ownership: ${ownerLevel} — ${ownerDisplayName}`
                  : `Ownership: ${ownerLevel}`
              }
            />
            <Button asChild variant="outline">
              <Link href={`/projects/${encodeURIComponent(project.id)}/settings`}>
                <Settings data-icon="inline-start" aria-hidden="true" />
                Project settings
              </Link>
            </Button>
          </div>
        }
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {isArchived && (
          <div className="soft-panel border-line bg-surface-muted px-4 py-3 text-xs text-muted-foreground">
            This project was archived
            {archivedAt ? ` on ${format(archivedAt, "MMM d, yyyy")}` : ""}.
            It is read-only — writes (new objects, agent runs, binding mutations) are
            rejected by <code>assertProjectWritable</code>. Use the project access
            controls to unarchive if you have admin role.
          </div>
        )}

        <ProjectDashboardsTab
          dataSource={dataSource}
          initialData={dashboardsInitial}
          overviewPortlets={overviewPortlets}
        />
      </PageContent>
    </Main>
  );
}
