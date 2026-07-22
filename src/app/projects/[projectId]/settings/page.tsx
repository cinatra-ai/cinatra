import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";

import * as authSession from "@/lib/auth-session";
const { requireAuthSession } = authSession;
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
// Re-exported from `@/lib/projects-store` so tests that mock the
// surface keep working (see settings-page.test.tsx).
import { projectsDb, readProjectById, readProjectCoOwners } from "@/lib/projects-store";
import { readOwnerDisplayName } from "@/lib/owner-display-names";
import { CrumbContributions } from "@/components/crumb-contributions";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { LifecycleBadge } from "@/components/lifecycle-badge";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import { AccessVsOwnershipNote } from "@/components/access-vs-ownership-note";
import { ProjectPermissionsTabClient } from "../permissions/permissions-tab-client";
import {
  readProjectOwnerViews,
  listProjectAccessAction,
  type ProjectAccessRow,
} from "../permissions/actions";
import { listGuestRows, type GuestRow } from "../permissions/guest-actions";

// ---------------------------------------------------------------------------
// `/projects/[projectId]/settings` — the single project-management surface
// (cinatra#1733, applying the #1693 teams ruling: the settings page absorbs
// the permissions surface). Hosts everything the former Permissions tab
// showed: ownership (owner + co-owners), N:M project-access grants, and the
// admin-only external guest grants. The former standalone /permissions route
// redirects here; the detail page links here via a header button.
// ---------------------------------------------------------------------------

// Gate-repeating metadata (cinatra#1737, the dashboards pattern): repeats the
// page's own 404-hide read gate before disclosing the project name; any
// failure yields the generic title.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  try {
    const [{ projectId }] = await Promise.all([params]);
    // Non-throwing session read (see the detail page's generateMetadata).
    const session = await authSession.getAuthSession();
    if (!session) return { title: "Project settings" };
    const actor = actorFromSession(session);
    const project = await readProjectById(projectId);
    if (!project) return { title: "Project settings" };
    const coOwners = await readProjectCoOwners(project.id);
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
    return { title: `Project settings — ${project.name}` };
  } catch {
    return { title: "Project settings" };
  }
}

type Props = {
  params: Promise<{ projectId: string }>;
};

const VALID_OWNER_LEVELS: ReadonlySet<string> = new Set([
  "user",
  "team",
  "organization",
  "workspace",
  "project",
]);

// Runtime narrow rather than `as ScopeLevel` cast, so a malformed DB row
// surfaces as `notFound()` instead of leaking through the type system.
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

export default async function ProjectSettingsPage({ params }: Props) {
  const [{ projectId }] = await Promise.all([params]);

  const session = await requireAuthSession();
  const actor = actorFromSession(session);
  const userId = actor.userId!;
  const orgId = actor.organizationId ?? null;

  const project = await readProjectById(projectId);
  if (!project) notFound();

  const coOwners = await readProjectCoOwners(project.id);

  // 404-hide on ACL miss — never reveal existence to actors lacking access.
  try {
    await enforceResourceAccess(
      {
        resourceType: "project",
        resourceId: project.id,
        // row tenant id, not actor's. See projects/[projectId]/page.tsx.
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

  // Owner display name for the badge (#1905) — covers team/org-owned
  // projects, which the USER-only readProjectOwnerViews below cannot.
  const ownerDisplayName = await readOwnerDisplayName(ownerLevel, project.ownerId);

  // Archived parity with the detail header (`archived_at` lives outside the
  // Drizzle binding — same raw read the detail page does): an admin changing
  // access must SEE the project is archived. Best-effort — a failed read
  // degrades to no badge, never a 500.
  let archivedAt: Date | null = null;
  try {
    const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
    const archivedResult = await projectsDb.execute<{ archived_at: Date | null }>(sql`
      SELECT archived_at FROM "${sql.raw(schema)}"."projects" WHERE id = ${project.id}
    `);
    archivedAt = archivedResult.rows[0]?.archived_at ?? null;
  } catch {
    archivedAt = null;
  }
  const isArchived = archivedAt !== null;

  // Owner display info + Better Auth enrichment. Wrapped defensively so a
  // transient Better Auth outage degrades to "Unknown" rather than 500ing
  // the page.
  let owner: Awaited<ReturnType<typeof readProjectOwnerViews>>["owner"] = null;
  let coOwnerViews: Awaited<ReturnType<typeof readProjectOwnerViews>>["coOwners"] = [];
  try {
    const views = await readProjectOwnerViews(
      project.ownerId,
      coOwners.map((c) => c.userId),
    );
    owner = views.owner;
    coOwnerViews = views.coOwners;
  } catch {
    owner = null;
    coOwnerViews = [];
  }

  // Platform-admin probe drives `canEdit`. Defensive call —
  // `isPlatformAdmin` may be unavailable in unit-test mocks of
  // `@/lib/auth-session`; treat any throw / absence as "not admin".
  let isAdmin = false;
  try {
    const fn = (authSession as unknown as { isPlatformAdmin?: (s: unknown) => boolean })
      .isPlatformAdmin;
    isAdmin = typeof fn === "function" ? fn(session) : false;
  } catch {
    isAdmin = false;
  }

  // Owner short-circuit drives canEdit.
  const canEdit = isAdmin || project.ownerId === userId;

  // List current project_access grants.
  // The list handler is gated on `read` role; a viewer that hits the
  // settings page already passed `project.read` above. Failures
  // degrade to an empty list so the page stays renderable.
  let projectAccessRows: ProjectAccessRow[] = [];
  const accessResult = await listProjectAccessAction(project.id);
  if (accessResult.ok) projectAccessRows = accessResult.items;

  // Guest rows are ADMIN-ONLY (guest emails are never shown to read-only
  // members): loaded only under canEdit — listGuestRows re-asserts
  // server-side — and degraded to empty on failure like the grants above.
  let guestRows: GuestRow[] = [];
  if (canEdit) {
    guestRows = await listGuestRows(project.id).catch(() => []);
  }

  return (
    <Main className="min-h-screen">
      {/* Post-gate crumb publisher (cinatra#1737): resolves the intermediate
          project-id crumb AND pins the leaf to "Settings" (the deliberate
          crumb contract beats the longer header title broadcast — the teams
          settings pattern). */}
      <CrumbContributions
        entries={[
          { prefix: `/projects/${encodeURIComponent(project.id)}`, label: project.name },
          {
            prefix: `/projects/${encodeURIComponent(project.id)}/settings`,
            label: "Settings",
          },
        ]}
      />
      <PageHeader
        title={`Project settings — ${project.name}`}
        description="Choose who can access this project and manage its owners."
        actions={
          <div className="flex items-center gap-2">
            {isArchived && <LifecycleBadge status="archived" />}
            <span data-testid="scope-badge">
              <ScopeBadge
                level={ownerLevel}
                ownerName={ownerDisplayName ?? undefined}
                aria-label={
                  ownerDisplayName
                    ? `Ownership: ${ownerLevel} — ${ownerDisplayName}`
                    : `Ownership: ${ownerLevel}`
                }
              />
            </span>
          </div>
        }
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* Clarify ownership vs access. */}
        <AccessVsOwnershipNote />
        <ProjectPermissionsTabClient
          activeOrgId={orgId}
          projectId={project.id}
          projectName={project.name}
          canEdit={canEdit}
          resourceOwner={owner}
          coOwners={coOwnerViews}
          currentUserId={userId}
          projectAccessRows={projectAccessRows}
          guestRows={guestRows}
        />
      </PageContent>
    </Main>
  );
}
