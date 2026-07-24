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
    // Per-entity multi-dashboard model (cinatra#700). Identity moves from the
    // single deterministic per-user id to the composite
    // (entity_type, entity_id, owner_level, owner_id, name). Additive: legacy
    // extension/unmapped rows keep entity_type/entity_id NULL and is_default
    // false, so they are excluded from the per-entity surface.
    /** Surface/entity kind this dashboard belongs to: 'personal'|'agents'|
     *  'artifacts'|'projects'|'teams'|'organizations' (+ future per-instance
     *  'project'|'team'|'organization'). NULL for extension-shipped / unmapped rows. */
    entityType: text("entity_type"),
    /** The specific entity instance id. For the current per-org surfaces this is
     *  the organization_id; for a per-instance detail surface it is the project/
     *  team/org id. NULL for extension-shipped / unmapped rows. */
    entityId: text("entity_id"),
    /** true on the non-removable "Overview" default for its (entity, owner). At
     *  most one true row per (org, entity_type, entity_id, owner_level, owner_id),
     *  enforced by a partial UNIQUE index + the mutation service. Overview cannot
     *  be renamed/archived/deleted (service-enforced). */
    isDefault: boolean("is_default").notNull().default(false),
    // dashboardContribution lineage + baseline snapshot (cinatra#1628, S11a).
    // Additive; legacy/operator rows keep these NULL. Mirrors drizzle-store.ts DDL.
    /** Carrier-independent immutable lineage id — survives the workflow→agent
     *  re-home. A template + its 0..N per-project instances SHARE one value;
     *  two-tier UNIQUE (template (contribution_id,org); instance
     *  (contribution_id,org,project)). NULL for operator/unmapped rows. */
    contributionId: text("contribution_id"),
    /** Provenance: the DATA version of the applied extension default. */
    appliedContributionVersion: integer("applied_contribution_version"),
    /** The extension-owned default SNAPSHOT — the baseline-backed 3-way merge
     *  base (S11b). NULL until a contribution materializes/upgrades the row. */
    appliedDefaultJson: jsonb("applied_default_json"),
    /** Fast change-detector over `applied_default_json`. */
    appliedDefaultHash: text("applied_default_hash"),
    /** Why an extension row was archived (orphan sweep / committed-uninstall). */
    archiveReason: text("archive_reason"),
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
    // Per-entity list lookups (cinatra#700).
    entityIdx: index("dashboards_entity_idx")
      .on(t.organizationId, t.entityType, t.entityId, t.ownerLevel, t.ownerId)
      .where(sql`entity_type IS NOT NULL`),
    // At most ONE Overview default per (org, entity, owner).
    entityDefaultUniq: uniqueIndex("dashboards_entity_default_uniq")
      .on(t.organizationId, t.entityType, t.entityId, t.ownerLevel, t.ownerId)
      .where(sql`is_default = true AND entity_type IS NOT NULL`),
    // Dashboard NAME is unique within (org, entity, owner).
    entityNameUniq: uniqueIndex("dashboards_entity_name_uniq")
      .on(t.organizationId, t.entityType, t.entityId, t.ownerLevel, t.ownerId, t.name)
      .where(sql`entity_type IS NOT NULL`),
    // Contribution-identity (cinatra#1628, S11a).
    contributionIdIdx: index("dashboards_contribution_id_idx")
      .on(t.contributionId)
      .where(sql`contribution_id IS NOT NULL`),
    // One TEMPLATE per (contribution, org).
    contributionTemplateUniq: uniqueIndex("dashboards_contribution_template_uniq")
      .on(t.contributionId, t.organizationId)
      .where(sql`contribution_id IS NOT NULL AND is_template = true`),
    // One INSTANCE per (contribution, org, project).
    contributionInstanceUniq: uniqueIndex("dashboards_contribution_instance_uniq")
      .on(t.contributionId, t.organizationId, t.projectId)
      .where(sql`contribution_id IS NOT NULL AND project_id IS NOT NULL`),
  }),
);

/**
 * Scope-collection SECONDARY LISTINGS (cinatra#1897 B4; ratified design spec at
 * design@bb9230d9b, `specs/app-artifacts.html` §IX). A dashboard's CANONICAL
 * HOME stays the singular `(entity_type, entity_id)` on `dashboards` (§VIII);
 * this junction adds a *separate listing relation* — a dashboard listed on a
 * scope's Dashboards tab as a reference, never a second home. The canonical home
 * never moves (a listing opens the same canonical surface / artifact detail), so
 * Overview protection and the per-entity name-uniqueness index on `dashboards`
 * are untouched by a listing.
 *
 * The scope kinds are the THREE shared add-to-scope scopes only — team, project,
 * organization (a personal user scope and the whole-workspace scope are not
 * add-to-scope targets, §IX). One listing per (dashboard, scope) — the UNIQUE
 * index makes add idempotent and remove exact.
 */
export const dashboardEntityLinks = cinatraSchema.table(
  "dashboard_entity_links",
  {
    id: text("id").primaryKey(),
    /** The listed dashboard — its canonical home is unaffected. */
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    /** The scope kind the dashboard is LISTED in: 'team'|'organization'|'project'
     *  — the three shared add-to-scope scopes (§IX); enforced by CHECK in DDL. */
    entityType: text("entity_type").notNull(),
    /** The scope instance id (team id / org id / project id). */
    entityId: text("entity_id").notNull(),
    /** The scope's tenant — denormalized from the dashboard's org at add time so a
     *  listing query stays tenant-scoped without a join. */
    organizationId: text("organization_id").notNull(),
    /** The manager who added the listing (attribution / audit). */
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One listing per (dashboard, scope) — makes add idempotent, remove exact.
    linkUniq: uniqueIndex("dashboard_entity_links_uniq").on(
      t.dashboardId,
      t.entityType,
      t.entityId,
    ),
    // Scope-listing lookup: "the dashboards LISTED in this scope".
    scopeIdx: index("dashboard_entity_links_scope_idx").on(
      t.entityType,
      t.entityId,
      t.organizationId,
    ),
    // Reverse lookup: "the scopes a dashboard is listed in" (scope chips / cascade).
    dashboardIdx: index("dashboard_entity_links_dashboard_idx").on(t.dashboardId),
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
export type DashboardEntityLinkRow = typeof dashboardEntityLinks.$inferSelect;
export type NewDashboardEntityLinkRow = typeof dashboardEntityLinks.$inferInsert;

/** The three shared scope kinds a dashboard may be LISTED in (§IX add-to-scope).
 *  A user scope and the whole-workspace scope are not add-to-scope targets. */
export const LISTING_SCOPE_KINDS = ["team", "organization", "project"] as const;
export type ListingScopeKind = (typeof LISTING_SCOPE_KINDS)[number];

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
