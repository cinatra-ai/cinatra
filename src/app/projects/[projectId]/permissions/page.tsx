import type { Metadata } from "next";
import { notFound } from "next/navigation";

import * as authSession from "@/lib/auth-session";
const { requireAuthSession } = authSession;
import {
  readOrgsWithTeamsForUser,
  readProjectsForUser,
  readTeamsByIdsForOrg,
} from "@/lib/better-auth-db";
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
import type { AccessComboboxProps } from "@/components/access-combobox";

type AvailableScopes = AccessComboboxProps["availableScopes"];

import { AccessVsOwnershipNote } from "@/components/access-vs-ownership-note";
import {
  collectAccessStateTeamIds,
  mergeResolvedTeams,
} from "./access-team-hydration";
import { ProjectPermissionsTabClient } from "./permissions-tab-client";
import {
  readProjectOwnerViews,
  listProjectAccessAction,
  type ProjectAccessRow,
} from "./actions";

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

  // Available scopes for the AccessCombobox — server-resolved, never
  // queried from the client. canGrantWorkspace stays admin-only (matches
  // the runs UI conservative ship). Defensive try/catch keeps the page
  // renderable when Better Auth probes fail.
  // Defensive call — `isPlatformAdmin` may be unavailable in unit-test
  // mocks of `@/lib/auth-session`; treat absence as "not admin".
  // Defer admin probe — vi.mock("@/lib/auth-session") in unit tests may
  // omit `isPlatformAdmin`; treat any throw / absence as "not admin".
  let isAdmin = false;
  try {
    const fn = (authSession as unknown as { isPlatformAdmin?: (s: unknown) => boolean })
      .isPlatformAdmin;
    isAdmin = typeof fn === "function" ? fn(session) : false;
  } catch {
    isAdmin = false;
  }
  const orgs = userId
    ? await readOrgsWithTeamsForUser(userId).catch(() => [])
    : [];
  const projectScopes =
    userId && orgId
      ? await readProjectsForUser(userId, orgId).catch(() => [])
      : [];
  // Active org's teams + name for the access-combobox shape.
  const activeOrg = orgs.find((o) => o.id === orgId) ?? orgs[0];
  const viewerTeams = activeOrg?.teams ?? [];

  // Owner short-circuit drives canEdit.
  const canEdit = isAdmin || project.ownerId === userId;

  // List current project_access grants.
  // The list handler is gated on `read` role; a viewer that hits the
  // permissions page already passed `project.read` above. Failures
  // degrade to an empty list so the page stays renderable.
  let projectAccessRows: ProjectAccessRow[] = [];
  const accessResult = await listProjectAccessAction(project.id);
  if (accessResult.ok) projectAccessRows = accessResult.items;

  // Translate the row's (ownerLevel, ownerId) into the canonical access
  // expression the combobox understands.
  const initialAccess = ((): string => {
    if (ownerLevel === "user") return "owner";
    if (ownerLevel === "team") return `team:${project.ownerId}`;
    if (ownerLevel === "organization") return `org:${project.ownerId}`;
    if (ownerLevel === "workspace") return "workspace";
    return "owner";
  })();

  // Selection hydration (cinatra#1508 / #1509 §4.1, codex F5): `viewerTeams`
  // only carries the VIEWER's memberships, so a team referenced by the
  // project's stored access state would render as "Unknown team" for
  // non-members. Resolve names server-side for exactly that CLOSED,
  // server-derived id set (access expression + project_access rows — never a
  // client-supplied id), bounded by the PROJECT's own org. The viewer already
  // passed `project.read` above, so naming a team that is already attached to
  // this project's access state inside its own org discloses nothing new. Ids
  // failing the org check (or deleted teams) stay unresolved and keep the
  // explicit "Unknown team" fallback. Defensive catch: a Better Auth outage
  // degrades to the unhydrated view rather than 500ing the page.
  const accessStateTeamIds = collectAccessStateTeamIds(
    initialAccess,
    projectAccessRows,
  );
  const unresolvedTeamIds = accessStateTeamIds.filter(
    (id) => !viewerTeams.some((t) => t.id === id),
  );
  // An org-less project has no boundary to resolve within — skip and keep the
  // "Unknown team" fallback (fail closed, never widen the lookup).
  const projectOrgId = project.organizationId;
  const resolvedAccessTeams =
    unresolvedTeamIds.length > 0 && projectOrgId
      ? await readTeamsByIdsForOrg(unresolvedTeamIds, projectOrgId).catch(() => [])
      : [];

  const availableScopes: AvailableScopes = {
    teams: mergeResolvedTeams(viewerTeams, resolvedAccessTeams),
    projects: projectScopes,
    orgName: activeOrg?.name ?? "",
    workspaceExposed: isAdmin,
  };

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
          initialAccess={initialAccess}
          canEdit={canEdit}
          availableScopes={availableScopes}
          resourceOwner={owner}
          coOwners={coOwnerViews}
          currentUserId={userId}
          projectAccessRows={projectAccessRows}
        />
      </PageContent>
    </Main>
  );
}
