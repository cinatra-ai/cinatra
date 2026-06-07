import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { format } from "date-fns";
import { eq, sql } from "drizzle-orm";

import { requireAuthSession } from "@/lib/auth-session";
import { projectsDb, projects } from "@/lib/projects-store";
import { betterAuthDb } from "@/lib/better-auth-db";
import { readProjectCoOwners } from "@/lib/project-co-owners-store";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import { Button } from "@/components/ui/button";
import { LifecycleBadge } from "@/components/lifecycle-badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = { title: "Project" };

type Props = {
  params: Promise<{ projectId: string }>;
};

// ---------------------------------------------------------------------------
// `/projects/[projectId]` detail page.
//
// Project is NEVER an ownership tier — there is no promotion path between
// tiers. Access is N:M via `project_access`. The detail page shows:
//   1. PageHeader with ScopeBadge for owner level + an Archived badge when
//      `projects.archived_at IS NOT NULL`.
//   2. A "Project metadata" card with name / slug / description / owner /
//      organization / visibility / created.
//   3. A "Sealed-room counts" card — number of objects, agent runs, and
//      chat threads scoped to this project. Counts read directly from the
//      same physical columns sealed-room list handlers query
//      (`*.project_id = $projectId`), so the numbers match what the sealed
//      room exposes through its tooling.
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
  const session = await requireAuthSession();
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

  // (2) Read gate. Grants are resolved on the actor inside
  // `enforceResourceAccess` via the kernel's membership lookup; passing the
  // resource envelope is sufficient.
  const actor = actorFromSession(session);
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

  const ownerLevel = assertOwnerLevel(project.ownerLevel);

  // (3) Sealed-room counts — match the SQL list handlers run.
  // Each query filters on the table's `project_id` column directly.
  // We deliberately run three lightweight COUNT(*) calls rather than a
  // UNION ALL: the indexes are partial `(project_id, created_at DESC)
  // WHERE project_id IS NOT NULL` on each table (SC-10), so an index-only
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
      SELECT COUNT(*)::text AS c FROM "${sql.raw(schema)}"."chat_threads"
       WHERE project_id = ${project.id}
    `),
  ]);
  const objectsCount = Number(objectsCountRes.rows[0]?.c ?? "0");
  const runsCount = Number(runsCountRes.rows[0]?.c ?? "0");
  const threadsCount = Number(threadsCountRes.rows[0]?.c ?? "0");

  // Owner display name (best-effort — fall back to id on Better Auth
  // outage so the page stays renderable).
  let ownerDisplayName: string | null = null;
  let orgDisplayName: string | null = null;
  try {
    if (ownerLevel === "user") {
      const u = await betterAuthDb.execute<{ name: string | null; email: string | null }>(sql`
        SELECT name, email FROM public."user" WHERE id = ${project.ownerId} LIMIT 1
      `);
      ownerDisplayName = u.rows[0]?.name ?? u.rows[0]?.email ?? null;
    } else if (ownerLevel === "team") {
      const t = await betterAuthDb.execute<{ name: string }>(sql`
        SELECT name FROM public."team" WHERE id = ${project.ownerId} LIMIT 1
      `);
      ownerDisplayName = t.rows[0]?.name ?? null;
    } else if (ownerLevel === "organization") {
      const o = await betterAuthDb.execute<{ name: string }>(sql`
        SELECT name FROM public."organization" WHERE id = ${project.ownerId} LIMIT 1
      `);
      ownerDisplayName = o.rows[0]?.name ?? null;
    }
    if (project.organizationId) {
      const o = await betterAuthDb.execute<{ name: string }>(sql`
        SELECT name FROM public."organization" WHERE id = ${project.organizationId} LIMIT 1
      `);
      orgDisplayName = o.rows[0]?.name ?? null;
    }
  } catch {
    // Best-effort; leave names as null.
  }

  const isArchived = archivedAt !== null;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={project.name}
        description="Bounded work context where agents run, project-specific capabilities are reused, data is created, approvals happen, and outputs accumulate."
        actions={
          <div className="flex items-center gap-2">
            {isArchived && <LifecycleBadge status="archived" />}
            <ScopeBadge level={ownerLevel} aria-label={`Ownership: ${ownerLevel}`} />
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${project.id}/permissions`}>Permissions</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${project.id}/agents`}>Agents</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${project.id}/customers`}>Customers</Link>
            </Button>
          </div>
        }
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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Project metadata</CardTitle>
            <CardDescription>
              Identifiers and ownership for this project.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Slug</dt>
                <dd className="font-mono text-xs text-foreground">{project.slug}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Identifier</dt>
                <dd className="font-mono text-xs text-foreground">{project.id}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Owner</dt>
                <dd className="flex items-center gap-2 text-foreground">
                  <ScopeBadge level={ownerLevel} />
                  <span>{ownerDisplayName ?? project.ownerId}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Organization</dt>
                <dd className="text-foreground">
                  {orgDisplayName ?? project.organizationId ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Visibility</dt>
                <dd className="text-foreground">
                  {project.visibility === "discoverable" ? "Discoverable" : "Private"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd className="text-foreground">
                  {format(project.createdAt, "MMM d, yyyy")}
                </dd>
              </div>
              {project.description && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Description</dt>
                  <dd className="text-foreground whitespace-pre-wrap">
                    {project.description}
                  </dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sealed room</CardTitle>
            <CardDescription>
              Resources scoped to this project. Counts match the sealed-room
              filter used by the list primitives — no cross-project bleed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="soft-panel flex flex-col gap-1 p-4">
                <dt className="text-xs text-muted-foreground">Objects</dt>
                <dd className="text-2xl font-semibold tabular-nums text-foreground">
                  {objectsCount.toLocaleString()}
                </dd>
                <p className="text-xs text-muted-foreground">
                  Includes artifacts (objects rows with an artifact type).
                </p>
              </div>
              <div className="soft-panel flex flex-col gap-1 p-4">
                <dt className="text-xs text-muted-foreground">Agent runs</dt>
                <dd className="text-2xl font-semibold tabular-nums text-foreground">
                  {runsCount.toLocaleString()}
                </dd>
                <p className="text-xs text-muted-foreground">
                  Runs with <code>project_id = {project.id}</code>.
                </p>
              </div>
              <div className="soft-panel flex flex-col gap-1 p-4">
                <dt className="text-xs text-muted-foreground">Chat threads</dt>
                <dd className="text-2xl font-semibold tabular-nums text-foreground">
                  {threadsCount.toLocaleString()}
                </dd>
                <p className="text-xs text-muted-foreground">
                  Threads with <code>project_id = {project.id}</code>.
                </p>
              </div>
            </dl>
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}
