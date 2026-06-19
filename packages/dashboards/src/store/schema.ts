/**
 * Drizzle schema for the dashboards platform.
 *
 * Mirrors the DDL in `src/lib/drizzle-store.ts` exactly. The schema namespace
 * is configurable via `SUPABASE_SCHEMA` (default: `cinatra`) so per-worktree
 * isolated dev instances resolve to their own `cinatra_<slug>` schema.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const SCHEMA_NAME = process.env.SUPABASE_SCHEMA ?? "cinatra";
const cinatraSchema = pgSchema(SCHEMA_NAME);

/** Dashboards platform table. */
export const dashboards = cinatraSchema.table(
  "dashboards",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    configJson: jsonb("config_json").notNull(),
    configVersion: text("config_version").notNull().default("v1.2"), // DASHBOARD_CONFIG_VERSION=v1.2 (apiVersion default; mirrors drizzle-store.ts DDL — cinatra#327)
    dashboardVersion: integer("dashboard_version").notNull().default(1),
    /** Pointer at the latest published revision; NULL while status='draft'. */
    publishedRevisionNumber: integer("published_revision_number"),
    /** 'user' | 'team' | 'organization' | 'workspace' — enforced by CHECK in DDL. */
    ownerLevel: text("owner_level").notNull(),
    ownerId: text("owner_id").notNull(),
    organizationId: text("organization_id").notNull(),
    /** 'private' | 'owners' | 'members' — enforced by CHECK in DDL. */
    visibility: text("visibility").notNull().default("private"),
    /** 'draft' | 'published' | 'archived' | 'generation_failed' — enforced by CHECK in DDL. */
    status: text("status").notNull().default("draft"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // Extension-shipped + project-scoped dashboards. Additive;
    // existing rows default to operator-authored (extension_id NULL, is_template
    // false, project_id NULL). owner_level stays the ownership axis; project_id is
    // a refinement layered on top (gated by project_access).
    /** Non-null when project-scoped (a per-project instance or a project-scope template). */
    projectId: text("project_id"),
    /** Non-null when extension-owned (vs operator-authored). Holds the package name. */
    extensionId: text("extension_id"),
    /** true on the extension TEMPLATE row; per-project instances + operator rows are false. */
    isTemplate: boolean("is_template").notNull().default(false),
    /** Set ONLY on template rows: 'organization'|'team'|'workspace'|'user'|'project'. */
    templateScope: text("template_scope"),
  },
  (t) => ({
    orgIdIdx: index("dashboards_org_id_idx").on(t.organizationId),
    ownerIdx: index("dashboards_owner_idx").on(t.ownerLevel, t.ownerId),
    statusIdx: index("dashboards_status_idx").on(t.status),
    createdAtIdx: index("dashboards_created_at_idx").on(t.createdAt),
    projectIdx: index("dashboards_project_id_idx").on(t.projectId),
    // One TEMPLATE per (extension, org).
    extTemplateUniq: uniqueIndex("dashboards_ext_template_uniq")
      .on(t.extensionId, t.organizationId)
      .where(sql`extension_id IS NOT NULL AND is_template = true`),
    // One INSTANCE per (extension, org, project).
    extInstanceUniq: uniqueIndex("dashboards_ext_instance_uniq")
      .on(t.extensionId, t.organizationId, t.projectId)
      .where(sql`extension_id IS NOT NULL AND project_id IS NOT NULL`),
  }),
);

export const dashboardRevisions = cinatraSchema.table(
  "dashboard_revisions",
  {
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    configJson: jsonb("config_json").notNull(),
    configVersion: text("config_version").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.dashboardId, t.revisionNumber] }),
    createdAtIdx: index("dashboard_revisions_created_at_idx").on(t.createdAt),
  }),
);

export type DashboardRow = typeof dashboards.$inferSelect;
export type NewDashboardRow = typeof dashboards.$inferInsert;
export type DashboardRevisionRow = typeof dashboardRevisions.$inferSelect;
export type NewDashboardRevisionRow = typeof dashboardRevisions.$inferInsert;

/** Supported ownership levels. */
export const OWNER_LEVELS = ["user", "team", "organization", "workspace"] as const;
export type OwnerLevel = (typeof OWNER_LEVELS)[number];

export const VISIBILITIES = ["private", "owners", "members"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const DASHBOARD_STATUSES = [
  "draft",
  "published",
  "archived",
  "generation_failed",
] as const;
export type DashboardStatus = (typeof DASHBOARD_STATUSES)[number];
