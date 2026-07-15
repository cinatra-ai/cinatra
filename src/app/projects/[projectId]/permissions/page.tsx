import type { Metadata } from "next";
import { notFound } from "next/navigation";

import * as authSession from "@/lib/auth-session";
const { requireAuthSession } = authSession;
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
// Re-exported from `@/lib/projects-store` so tests that mock the
// surface keep working (see permissions-page.test.tsx).
import { readProjectById, readProjectCoOwners } from "@/lib/projects-store";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { ProjectSubnav } from "@/components/project-subnav";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import { AccessVsOwnershipNote } from "@/components/access-vs-ownership-note";
import { ProjectPermissionsTabClient } from "./permissions-tab-client";
import {
  readProjectOwnerViews,
  listProjectAccessAction,
  type ProjectAccessRow,
} from "./actions";
import { listGuestRows, type GuestRow } from "./guest-actions";

export const metadata: Metadata = { title: "Project permissions" };

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

export default async function ProjectPermissionsPage({ params }: Props) {
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
  // permissions page already passed `project.read` above. Failures
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
      <PageHeader
        title={project.name}
        description="Choose who can access this project and manage its owners."
        actions={
          <span data-testid="scope-badge">
            <ScopeBadge level={ownerLevel} aria-label={`Ownership: ${ownerLevel}`} />
          </span>
        }
        divider={false}
      />
      <ProjectSubnav projectId={project.id} activeSection="permissions" />
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
