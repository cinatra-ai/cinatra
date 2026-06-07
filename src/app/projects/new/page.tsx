import "server-only";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";

/**
 * Mirrors the database slug-normalization helper.
 * Trims hyphens, collapses non-alphanum runs to `-`, falls back to "item"
 * when empty, caps at 60 chars (leaving budget for `-N` suffix on collision).
 */
function normalizeSlug(input: string): string {
  const stripped = (input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (stripped || "item").slice(0, 60);
}

import { requireAuthSession } from "@/lib/auth-session";
import { actorFromSession, type ActorRoleHints } from "@/lib/authz/build-actor-context";
import { betterAuthDb } from "@/lib/better-auth-db";
import { projectsDb, projects } from "@/lib/projects-store";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
// Ownership-authority checks live inline in the MCP `projects_create`
// handler. The helper module remains available for existing callers.
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";

import { NewProjectForm } from "./new-project-form";
import { resolveOwnerId, type OwnerLevel } from "./resolve-owner-id";

export const metadata: Metadata = { title: "New project" };

// Inline server action: "use server" goes inside the function body, not at file level.
// Re-validate session at the top of every server action; do not trust the page-level auth check.
async function createProjectAction(formData: FormData) {
  "use server";
  const session = await requireAuthSession();

  const name = ((formData.get("name") as string | null) ?? "").trim();
  if (!name) {
    redirect("/projects/new?error=name-required");
  }
  if (name.length > 255) {
    redirect("/projects/new?error=name-too-long");
  }

  const description = ((formData.get("description") as string | null) ?? "").trim() || null;
  const rawOwnerLevel = (formData.get("ownerLevel") as string | null) ?? "";
  const ownerLevel = (["user", "team", "organization"].includes(rawOwnerLevel)
    ? rawOwnerLevel
    : "") as OwnerLevel;

  const teamId = (formData.get("teamId") as string | null) ?? undefined;
  const organizationId = (formData.get("organizationId") as string | null) ?? undefined;

  // Mass-assignment defense: NEVER read an `ownerId` field from formData.
  // Always resolve server-side from session + ownerLevel + teamId/organizationId.
  const resolved = resolveOwnerId({
    sessionUserId: session.user.id,
    ownerLevel,
    teamId,
    organizationId,
  });
  if ("error" in resolved) {
    redirect(`/projects/new?error=${resolved.error}`);
  }

  // IDOR / authorization guard: verify the calling user is actually a member of
  // the chosen team or organization before creating a project under that scope.
  // Also fetch the member role so the auth gate below can derive effective
  // permissions without a second round-trip.
  let teamMemberRole: string | null = null;
  let orgMemberRole: string | null = null;

  if (ownerLevel === "team" && teamId) {
    const memberRows = await betterAuthDb.execute<{ role: string | null }>(sql`
      SELECT role
      FROM public."teamMember"
      WHERE "userId" = ${session.user.id} AND "teamId" = ${teamId}
      LIMIT 1
    `);
    teamMemberRole = memberRows.rows[0]?.role ?? null;
    if (!teamMemberRole) {
      redirect("/projects/new?error=not-a-team-member");
    }
  }

  if (ownerLevel === "organization" && organizationId) {
    const memberRows = await betterAuthDb.execute<{ role: string | null }>(sql`
      SELECT role
      FROM public.member
      WHERE "userId" = ${session.user.id} AND "organizationId" = ${organizationId}
      LIMIT 1
    `);
    orgMemberRole = memberRows.rows[0]?.role ?? null;
    if (!orgMemberRole) {
      redirect("/projects/new?error=not-an-org-member");
    }
  }

  const rawVisibility = (formData.get("visibility") as string | null) ?? "private";
  const visibility = (rawVisibility === "discoverable" ? "discoverable" : "private") as
    | "private"
    | "discoverable";

  // Creation authorization gate. Even though the IDOR membership checks
  // above already ensure the actor belongs to the requested team/org, the
  // scope guard additionally requires team_admin / org_admin to
  // actually CREATE a project at that tier, mirroring updateProjectAction.
  //
  // actorFromSession only reads session.user.role (platform tier) — it never
  // queries the org/team membership tables. Enrich the actor with the roles
  // fetched above so authorization checks see the actor's effective grants.
  const ratchetActor = actorFromSession(session);
  const enrichedRoles = [...(ratchetActor.roles ?? [])];
  const enrichedTeamRoles: Record<string, string> = {};
  let roleHintsOverride: ActorRoleHints | undefined;

  if (ownerLevel === "team" && teamId && teamMemberRole) {
    const teamRoleValue = teamMemberRole === "admin" ? "team_admin" : "member";
    enrichedRoles.push(teamRoleValue);
    enrichedTeamRoles[teamId] = teamRoleValue;
  }

  if (ownerLevel === "organization" && organizationId && orgMemberRole) {
    // Organization admin checks expect actor.roles to contain "owner" or "admin".
    enrichedRoles.push(orgMemberRole);
    const mappedOrgRole: ActorRoleHints["orgRole"] =
      orgMemberRole === "owner" ? "org_owner" :
      orgMemberRole === "admin" ? "org_admin" :
      "member";
    roleHintsOverride = { orgRole: mappedOrgRole, actorOrganizationId: organizationId };
  }

  const enrichedActor = {
    ...ratchetActor,
    roles: enrichedRoles,
    ...(Object.keys(enrichedTeamRoles).length > 0 ? { teamRoles: enrichedTeamRoles } : {}),
  };
  const session2OrgId = enrichedActor.organizationId ?? null;

  try {
    await enforceResourceAccess(
      {
        resourceType: "project",
        resourceId: "<new>",
        organizationId: ownerLevel === "organization" ? (organizationId ?? session2OrgId) : session2OrgId,
        ownerLevel,
        ownerId: resolved.ownerId,
        visibility: null,
      },
      enrichedActor,
      "project.create",
      roleHintsOverride,
    );

    // The MCP `projects_create` handler applies the ownership-authority
    // check inline (user-owned must be self; team-owned requires
    // team_admin; org-owned requires matching active org +
    // org_admin/org_owner; workspace-owned requires platform_admin).
    // This server action retains the upstream `enforceResourceAccess`
    // `project.create` gate above plus the IDOR membership-check SQL
    // earlier in the action, which together provide equivalent
    // coverage for the page-driven flow.
  } catch (err) {
    // AuthzError.statusCode is stripped by Next.js serialization across the
    // server→client boundary, so the form catch block can't distinguish it
    // from a DB error. Redirect with an error code instead so the message
    // survives the boundary via the initialError prop path.
    if (err instanceof AuthzError) redirect("/projects/new?error=permission-denied");
    throw err;
  }

  // Derive a slug from the name (or accept an explicit slug from
  // the form) and retry on uniqueness violation. The DB enforces UNIQUE per
  // (owner_level, owner_id) so two projects with the same name under the
  // same owner get auto-numbered slugs (-2, -3, …).
  const explicitSlug = ((formData.get("slug") as string | null) ?? "").trim();
  const baseSlug = normalizeSlug(explicitSlug || name);

  const id = crypto.randomUUID();
  let attemptSlug = baseSlug;
  // Track success so we throw rather than silently redirect to a
  // non-existent project when every retry collides.
  let inserted = false;
  for (let n = 2; n <= 100; n++) {
    try {
      await projectsDb.insert(projects).values({
        id,
        name,
        description,
        ownerLevel,
        ownerId: resolved.ownerId,
        slug: attemptSlug,
        // Persist the row's tenant boundary so subsequent reads can
        // populate the kernel's resource.organizationId from the row, not
        // the requesting actor. See packages/projects/src/mcp/handlers.ts.
        organizationId: session2OrgId,
        visibility,
      });
      inserted = true;
      break;
    } catch (err) {
      // pg error code 23505 — unique_violation
      const pgErr = err as { code?: string; constraint?: string; message?: string };
      if (pgErr?.code === "23505" && /projects_slug_uniq/.test(String(pgErr.constraint ?? pgErr.message ?? ""))) {
        attemptSlug = `${baseSlug.slice(0, 60 - String(n).length - 1)}-${n}`;
        continue;
      }
      throw err;
    }
  }
  if (!inserted) {
    // Surface slug exhaustion rather than redirecting to /404.
    throw new Error(
      `projects.slug: could not allocate a unique slug after 100 attempts ` +
        `(baseSlug="${baseSlug}", owner=${ownerLevel}:${resolved.ownerId}). ` +
        `Manually pick a slug for this project or rename a colliding one.`,
    );
  }

  redirect(`/projects/${id}`);
}

// Human-readable messages for error codes produced by createProjectAction redirects.
const ACTION_ERROR_MESSAGES: Record<string, string> = {
  "name-required": "A project name is required.",
  "name-too-long": "Project name must be 255 characters or fewer.",
  "team-required": "Please select a team.",
  "org-required": "Please select an organization.",
  "invalid-owner-level": "Invalid ownership level — please try again.",
  "not-a-team-member": "You are not a member of the selected team.",
  "not-an-org-member": "You are not a member of the selected organization.",
  "permission-denied": "You don't have permission to create a project at this ownership level.",
};

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAuthSession();
  const userId = session.user.id;

  // Read error code from redirect (e.g. ?error=name-required) so the form can
  // surface it on mount rather than showing a silent blank form.
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const errorCode = typeof resolvedSearchParams.error === "string" ? resolvedSearchParams.error : undefined;
  const initialError = errorCode ? (ACTION_ERROR_MESSAGES[errorCode] ?? "Something went wrong — please try again.") : undefined;

  // Server-component fetch of the user's teams and organizations.
  const [teamRows, orgRows] = await Promise.all([
    betterAuthDb.execute<{ id: string; name: string; orgName: string }>(sql`
      SELECT t.id, t.name, o.name AS "orgName"
      FROM public.team t
      JOIN public.organization o ON o.id = t."organizationId"
      JOIN public."teamMember" tm ON tm."teamId" = t.id
      WHERE tm."userId" = ${userId}
      ORDER BY o.name, t.name
    `),
    betterAuthDb.execute<{ id: string; name: string }>(sql`
      SELECT o.id, o.name
      FROM public.organization o
      JOIN public.member m ON m."organizationId" = o.id
      WHERE m."userId" = ${userId}
      ORDER BY o.name
    `),
  ]);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="New project"
        description="Create a bounded work context. Choose where it lives — pick the smallest scope it needs, you can ratchet it up later."
      />
      <PageContent className="max-w-3xl flex flex-col gap-6 pb-8">
        <NewProjectForm
          teams={teamRows.rows}
          organizations={orgRows.rows}
          action={createProjectAction}
          initialError={initialError}
        />
      </PageContent>
    </Main>
  );
}
