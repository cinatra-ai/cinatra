/**
 * Vitest stub for `@/lib/projects-store`.
 *
 * The real module creates a pg.Pool at module load (SUPABASE_DB_URL
 * required), which crashes in node tests. The handlers use only
 * `projectsDb.execute(sql\`...\`)` from this stub — tests `vi.mock` the
 * stub to control execute() return values.
 */
export const projectsDb = {
  execute: async <_T = unknown>(
    _query: unknown,
  ): Promise<{ rows: never[] }> => ({ rows: [] }),
};

// projects + projectCoOwners drizzle bindings are imported by the
// handlers' module-level destructure; projects_list uses raw SQL.
// Export shape-only placeholders so module-load doesn't throw.
export const projects = {};
export const projectCoOwners = {};

// readProjectById is re-exported from projects-store in the real module
// via the projects-store-dao barrel. Tests mock the DAO stub directly.
export type ProjectRecord = {
  id: string;
  name: string;
  description: string | null;
  ownerLevel: string;
  ownerId: string;
  organizationId: string | null;
  visibility: string;
  slug: string;
  createdAt: Date;
};
