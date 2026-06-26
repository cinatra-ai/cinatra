import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema, text, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { getPooledDb } from "@/lib/db/pooled";

const cinatraSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");

export const projects = cinatraSchema.table(
  "projects",
  {
    id:             text("id").primaryKey(),
    name:           text("name").notNull(),
    description:    text("description"),
    ownerLevel:     text("owner_level").notNull(),
    ownerId:        text("owner_id").notNull(),
    // organization_id is the row's tenant boundary, separate from owner_id.
    // The kernel cross-org guard compares this column against the actor's
    // active org. Nullable for existing rows and for workspace-tier projects
    // that span the whole platform instance. New rows are populated by
    // `projects_create` / `createProjectAction` from the requester's active
    // org; user-owned projects also carry the creator's active org so a
    // cross-tenant user-owner short-circuit cannot bypass the guard.
    organizationId: text("organization_id"),
    visibility:     text("visibility").notNull().default("private"),
    // slug column with format CHECK + UNIQUE per (owner_level, owner_id)
    // enforced by drizzle-store.ts migration. NOT NULL after the migration runs.
    slug:           text("slug").notNull(),
    createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx:     index("projects_owner_idx").on(t.ownerLevel, t.ownerId),
    // DESC to match the DDL migration: CREATE INDEX ... (created_at DESC).
    // This codebase uses raw SQL migrations (not drizzle-kit), so the Drizzle
    // ORM index declaration is advisory only — the actual index direction is
    // controlled by the DDL in drizzle-store.ts. The declaration here is kept
    // in sync with DESC to avoid confusion during future migrations reviews.
    createdAtIdx: index("projects_created_at_idx").on(t.createdAt.desc()),
    orgIdx:       index("projects_organization_id_idx").on(t.organizationId),
  }),
);

export type ProjectRecord = typeof projects.$inferSelect;
export type NewProjectRecord = typeof projects.$inferInsert;

// project_co_owners join table binding.
// Mirrors runCoOwners (packages/agent-builder/src/schema.ts:353) verbatim.
// Cross-schema FKs to public."user" are added by the runtime migration in
// drizzle-store.ts; this binding intentionally does NOT declare references()
// for user_id / granted_by to avoid the cinatra-app -> Better Auth import
// boundary issue. The runtime migration is the source of truth for those
// constraints.
export const projectCoOwners = cinatraSchema.table(
  "project_co_owners",
  {
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    userId:    text("user_id").notNull(),
    grantedBy: text("granted_by").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:        primaryKey({ columns: [t.projectId, t.userId] }),
    userIdIdx: index("project_co_owners_user_id_idx").on(t.userId),
  }),
);

export type ProjectCoOwnerRecord = typeof projectCoOwners.$inferSelect;

// Lazy pool + drizzle bootstrap over the shared pool (@/lib/db/pooled, #303).
// The pool is created on first use (not at module import) so `next build`
// page-data collection — and any other import-time evaluation without
// SUPABASE_DB_URL — does not throw, and an idle-error listener keeps the process
// alive when Supabase drops idle connections.
function getProjectsPool(): Pool {
  return getPooledDb({ name: "projects-store" });
}

function createProjectsDb() {
  return drizzle(getProjectsPool(), { schema: { projects, projectCoOwners } });
}
let projectsDbInstance: ReturnType<typeof createProjectsDb> | undefined;
function getProjectsDb(): ReturnType<typeof createProjectsDb> {
  return (projectsDbInstance ??= createProjectsDb());
}

// Lazy value-export proxies preserve the existing `projectsPool` /
// `projectsDb` import contract (zero consumer changes) while deferring pool
// creation to first use. Method access is bound to the real target.
export const projectsPool: Pool = new Proxy({} as Pool, {
  get(_t, prop) {
    const target: any = getProjectsPool();
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export const projectsDb: ReturnType<typeof createProjectsDb> = new Proxy(
  {} as ReturnType<typeof createProjectsDb>,
  {
    get(_t, prop) {
      const target: any = getProjectsDb();
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);

// ---------------------------------------------------------------------------
// Re-exports so callers and tests that mock `@/lib/projects-store` have a
// single import surface for read helpers. The implementations live in their
// dedicated DAO modules so unit tests can mock them granularly when needed.
// ---------------------------------------------------------------------------
export { readProjectById } from "./projects-store-dao";
export { readProjectCoOwners } from "./project-co-owners-store";
