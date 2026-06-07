"use server";

import { revalidatePath } from "next/cache";
import { requireAuthSession } from "@/lib/auth-session";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
import { readProjectCoOwners } from "@/lib/project-co-owners-store";
import { readProjectById, updateProject } from "@/lib/projects-store-dao";
import type { ProjectRecord } from "@/lib/projects-store";

import { assertScopeRatchet } from "./scope-ratchet";

// Explicit OwnerLevel allow-list used to validate client-supplied
// `ownerLevel` form fields. Any value outside the set is rejected before
// it can reach `assertScopeRatchet` (where an unknown level used to fall
// through the switch statement and silently allow the write).
const OWNER_LEVEL_VALUES = new Set<"user" | "team" | "organization" | "workspace">([
  "user",
  "team",
  "organization",
  "workspace",
]);
function isOwnerLevel(value: string): value is "user" | "team" | "organization" | "workspace" {
  return OWNER_LEVEL_VALUES.has(value as "user" | "team" | "organization" | "workspace");
}

// ---------------------------------------------------------------------------
// Project server actions (update + delete).
//
// Authorization invariants:
//   - both actions enforce `enforceResourceAccess` against the live row
//     before any mutation
//   - `updateProjectAction` ignores any client-supplied `ownerLevel` /
//     `ownerId` unless it ALSO passes `assertScopeRatchet` against the
//     actor's roles (mass-assignment defense)
//   - `deleteProjectAction` is OWNER-ONLY: project.delete is not in
//     `RESOURCE_COOWNER_OPS`, so the kernel denies co-owners outright.
//
// Note: server actions returning typed objects (not redirects) so unit
// tests can assert post-conditions without mocking next/navigation.
// ---------------------------------------------------------------------------

// `actorFromSession` lives at `@/lib/authz/build-actor-context`.

export async function updateProjectAction(formData: FormData): Promise<{
  id: string;
  name: string;
  description: string | null;
  ownerLevel: "user" | "team" | "organization" | "workspace";
  ownerId: string;
  visibility: "private" | "discoverable";
}> {
  const session = await requireAuthSession();
  const actor = actorFromSession(session);

  const projectId = String(formData.get("projectId") ?? "").trim();
  if (!projectId) {
    throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
  }

  const project = await readProjectById(projectId);
  const coOwners = project ? await readProjectCoOwners(project.id) : [];

  await enforceResourceAccess(
    project
      ? {
          resourceType: "project",
          resourceId: project.id,
          // Use the row's `organization_id` so the kernel cross-org
          // guard compares `actor.org` vs `resource.org` properly. Legacy
          // rows with NULL organization IDs still short-circuit on null.
          organizationId: project.organizationId,
          ownerLevel: normalizeOwnerLevel(project.ownerLevel),
          ownerId: project.ownerId,
          visibility: null,
          coOwnerUserIds: coOwners.map((c) => c.userId),
        }
      : null,
    actor,
    "project.update",
  );

  // Mass-assignment guard. Read-but-ignore client ownership fields unless
  // the actor can satisfy the scope ratchet for the requested target.
  const requestedOwnerLevel = formData.get("ownerLevel") as string | null;
  const requestedOwnerId = formData.get("ownerId") as string | null;
  let nextOwnerLevel = normalizeOwnerLevel(project!.ownerLevel);
  let nextOwnerId = project!.ownerId;
  if (requestedOwnerLevel && requestedOwnerId && isOwnerLevel(requestedOwnerLevel)) {
    const candidateLevel: typeof nextOwnerLevel = requestedOwnerLevel;
    try {
      await assertScopeRatchet({
        from: { ownerLevel: nextOwnerLevel, ownerId: nextOwnerId },
        to:   { ownerLevel: candidateLevel, ownerId: requestedOwnerId },
        actor,
      });
      nextOwnerLevel = candidateLevel;
      nextOwnerId = requestedOwnerId;
    } catch (err) {
      // Silently drop the bad promotion attempt — never escalate. The
      // owner can still rename / re-describe the project, but the
      // ownership tuple stays as it was.
      if (!(err instanceof AuthzError)) throw err;
    }
  }

  const name = (formData.get("name") as string | null)?.trim();
  const description = formData.get("description") as string | null;
  const visibility = (formData.get("visibility") as string | null) as
    | "private"
    | "discoverable"
    | null;

  const patch: Record<string, unknown> = {};
  if (name && name !== project!.name) patch.name = name;
  if (description !== null && description !== project!.description) {
    patch.description = description.trim() === "" ? null : description;
  }
  if (nextOwnerLevel !== project!.ownerLevel) patch.ownerLevel = nextOwnerLevel;
  if (nextOwnerId !== project!.ownerId) patch.ownerId = nextOwnerId;
  if (visibility && visibility !== project!.visibility) patch.visibility = visibility;

  if (Object.keys(patch).length > 0) {
    await updateProject(project!.id, patch as never);
  }

  return {
    id: project!.id,
    name: typeof patch.name === "string" ? patch.name : project!.name,
    description: "description" in patch ? (patch.description as string | null) : project!.description,
    ownerLevel: nextOwnerLevel,
    ownerId: nextOwnerId,
    visibility: (visibility ?? project!.visibility) as "private" | "discoverable",
  };
}

// `deleteProjectAction` is DISABLED. The project lifecycle is archive-only.
// This server action stays exported so any stale client import resolves
// without a build error, but throws on call so no caller can silently
// hard-delete a project.
export async function deleteProjectAction(_formData: FormData): Promise<{ ok: true }> {
  throw new Error("project deletion removed — archive only");
}

// ---------------------------------------------------------------------------
// Project slug rename action.
//
// The DB trigger on cinatra.projects.slug UPDATE enqueues a path_relocations
// row that the relocation worker picks up. This action is the user-facing
// surface to trigger that UPDATE, with auth gates matching updateProjectAction.
// ---------------------------------------------------------------------------

/**
 * Slug format mirror of the DB CHECK constraint:
 *   ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$  AND  NOT LIKE '~%'
 */
function isValidProjectSlug(slug: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && !slug.startsWith("~");
}

export async function renameProjectSlugAction(formData: FormData): Promise<{
  ok: true;
  projectId: string;
  oldSlug: string;
  newSlug: string;
} | {
  ok: false;
  error: "invalid-slug" | "not-found" | "forbidden" | "slug-conflict";
}> {
  const session = await requireAuthSession();
  const actor = actorFromSession(session);

  const projectId = String(formData.get("projectId") ?? "").trim();
  const newSlug = String(formData.get("newSlug") ?? "").trim().toLowerCase();

  if (!projectId) {
    return { ok: false, error: "not-found" };
  }
  if (!newSlug || !isValidProjectSlug(newSlug)) {
    return { ok: false, error: "invalid-slug" };
  }

  const project = await readProjectById(projectId);
  if (!project) {
    return { ok: false, error: "not-found" };
  }
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
      "project.update",
    );
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: "forbidden" };
    throw err;
  }

  const oldSlug = (project as ProjectRecord & { slug?: string }).slug ?? "";
  if (oldSlug === newSlug) {
    return { ok: true, projectId: project.id, oldSlug, newSlug };
  }

  try {
    await updateProject(project.id, { slug: newSlug });
  } catch (err) {
    // Cover both 23505 (UNIQUE) and 23514 (CHECK violations).
    const pgErr = err as { code?: string; constraint?: string; message?: string };
    const constraint = String(pgErr.constraint ?? pgErr.message ?? "");
    if (pgErr?.code === "23505" && /projects_slug_uniq/.test(constraint)) {
      return { ok: false, error: "slug-conflict" };
    }
    if (pgErr?.code === "23514" && /projects_slug_format/.test(constraint)) {
      return { ok: false, error: "invalid-slug" };
    }
    throw err;
  }

  // Surface the rename to the project page + list page on next render.
  revalidatePath(`/projects/${project.id}`);
  revalidatePath(`/projects`);
  return { ok: true, projectId: project.id, oldSlug, newSlug };
}
