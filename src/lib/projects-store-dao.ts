import "server-only";
import { eq } from "drizzle-orm";
import { projects, projectsDb, type ProjectRecord } from "@/lib/projects-store";

// ---------------------------------------------------------------------------
// Raw DAO helpers around cinatra.projects.
//
// Kept in a separate module from the schema bindings (`projects-store.ts`)
// so that:
//   1. Unit tests can `vi.mock("@/lib/projects-store-dao", ...)` without
//      pulling in the real pg.Pool initialization.
//   2. Schema-binding consumers (e.g. drizzle migrations) don't import
//      query helpers they don't need.
//
// These helpers are the canonical update/delete entrypoints for projects.
// ---------------------------------------------------------------------------

export type ProjectPatch = Partial<{
  name: string;
  description: string | null;
  ownerLevel: "user" | "team" | "organization" | "workspace";
  ownerId: string;
  visibility: "private" | "discoverable";
  slug: string;
}>;

export async function readProjectById(id: string): Promise<ProjectRecord | null> {
  const rows = await projectsDb.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateProject(id: string, patch: ProjectPatch): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await projectsDb.update(projects).set(patch).where(eq(projects.id, id));
}

export async function deleteProject(id: string): Promise<void> {
  await projectsDb.delete(projects).where(eq(projects.id, id));
}
