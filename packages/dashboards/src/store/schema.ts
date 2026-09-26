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
    /** 'user' | 'team' | 'organization' | 'workspace' — enforced by CHECK in DDL.
     *  The SCOPE axis: the sole ownership input the canonical ACL derives from
     *  (`deriveDashboardScopeTuple` / `resolveDashboardAccess`). NOT demoted by
     *  the #1898 cutover — the column that retired was `visibility` (see below). */
    ownerLevel: text("owner_level").notNull(),
    ownerId: text("owner_id").notNull(),
    /** The tenant. NULL exactly for a WORKSPACE dashboard (cinatra#2811): the
     *  workspace sits above every organization, so its user-owned rows carry no
     *  tenant; `dashboards_workspace_entity_org_check` binds NULL to
     *  entity_type='workspace' in both directions (migration core__0108). */
    organizationId: text("organization_id"),
    // ACL cutover Phase-3 (cinatra#1898, epic #1883 §D7): the dashboard-local
    // `visibility` column ('private'|'owners'|'members') is DROPPED here
    // (migration core__0087). Phase-2 stopped reading it — a dashboard is always
    // visible to everyone in its scope — and this phase removes the demoted
    // column plus its CHECK after the resolver soak. Scope-derived visibility
    // lives exclusively on the paired `objects` twin's canonical tuple.
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
    // The ORG-NULL TWINS of the three per-entity indexes (cinatra#2811). NULLs
    // are distinct in a unique index, so the org-keyed pair above cannot hold
    // "one Overview" / "one name" for a workspace row; each twin is partial on
    // `organization_id IS NULL`, so it never sees an organization row.
    workspaceEntityIdx: index("dashboards_workspace_entity_idx")
      .on(t.entityType, t.entityId, t.ownerLevel, t.ownerId)
      .where(sql`entity_type IS NOT NULL AND organization_id IS NULL`),
    workspaceEntityDefaultUniq: uniqueIndex("dashboards_workspace_entity_default_uniq")
      .on(t.entityType, t.entityId, t.ownerLevel, t.ownerId)
      .where(sql`is_default = true AND entity_type IS NOT NULL AND organization_id IS NULL`),
    workspaceEntityNameUniq: uniqueIndex("dashboards_workspace_entity_name_uniq")
      .on(t.entityType, t.entityId, t.ownerLevel, t.ownerId, t.name)
      .where(sql`entity_type IS NOT NULL AND organization_id IS NULL`),
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
 * design@0ead5d0c5, `specs/app-artifacts.html` §IX). A dashboard's CANONICAL
 * HOME stays the singular `(entity_type, entity_id)` on `dashboards` (§VIII);
 * this junction adds a *separate listing relation* — a dashboard listed on a
 * scope's Dashboards tab as a reference, never a second home. The canonical home
 * never moves (a listing opens the same canonical surface / artifact detail), so
 * Overview protection and the per-entity name-uniqueness index on `dashboards`
 * are untouched by a listing.
 *
 * The scope kinds are the three shared add-to-scope scopes (team, project,
 * organization) and, since cinatra#2811, the whole-workspace scope as a
 * REFERENCE target (§IX.1 / §IX.3). A personal user scope is never a target. One
 * listing per (dashboard, scope); the UNIQUE index makes add idempotent and
 * remove exact.
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
     *  (§IX) or 'workspace' (a §IX.3 workspace REFERENCE, cinatra#2811);
     *  enforced by CHECK in DDL. */
    entityType: text("entity_type").notNull(),
    /** The scope instance id (team id / org id / project id; '__workspace__'
     *  for a workspace reference, pinned by CHECK). */
    entityId: text("entity_id").notNull(),
    /** The scope's tenant — denormalized from the dashboard's org at add time so a
     *  listing query stays tenant-scoped without a join. For a WORKSPACE
     *  reference it is the TARGET dashboard's home organization: the listing
     *  authority (an organization admin curates the links whose target's home
     *  organization is theirs) and the read's tenant fence both key on it. */
    organizationId: text("organization_id").notNull(),
    /** The manager who added the listing (attribution / audit). */
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** §IX.4 "visible to everyone": a platform administrator's READ-ONLY grant
     *  on a WORKSPACE reference (cinatra#2811). The CHECK
     *  `dashboard_entity_links_workspace_grant_check` requires the two metadata
     *  columns exactly when it is set and forbids it on a non-workspace link.
     *  Its history is the append-only `audit_events` trail, never this row. */
    workspaceReadGranted: boolean("workspace_read_granted").notNull().default(false),
    workspaceReadGrantedBy: text("workspace_read_granted_by"),
    workspaceReadGrantedAt: timestamp("workspace_read_granted_at", { withTimezone: true }),
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

/** The scope kinds a dashboard may be LISTED in: the three shared add-to-scope
 *  scopes (§IX) and, since cinatra#2811, the whole-workspace scope as a
 *  REFERENCE target (§IX.1 / §IX.3). A personal user scope is never a target. */
export const LISTING_SCOPE_KINDS = ["team", "organization", "project", "workspace"] as const;
export type ListingScopeKind = (typeof LISTING_SCOPE_KINDS)[number];

/** The TENANT scope kinds: every listing kind but the workspace. A tenant
 *  scope's listing is fenced to ONE organization; the workspace collection spans
 *  organizations and is read, authorized and curated by its own arm. */
export type TenantListingScopeKind = Exclude<ListingScopeKind, "workspace">;

/** Supported ownership levels. */
export const OWNER_LEVELS = ["user", "team", "organization", "workspace"] as const;
export type OwnerLevel = (typeof OWNER_LEVELS)[number];

// The dashboard-local `{private, owners, members}` VISIBILITY VOCABULARY is
// RETIRED (cinatra#1898 ACL cutover): Phase-2 stopped consulting it, Phase-3
// (migration core__0087) dropped its column. A dashboard is always visible to
// everyone in its scope, so the only share axis is the canonical one carried by
// the paired `objects` twin (see `deriveDashboardScopeTuple`). Deliberately no
// replacement export here — a re-introduction would resurrect a second ACL.

export const DASHBOARD_STATUSES = [
  "draft",
  "published",
  "archived",
  "generation_failed",
] as const;
export type DashboardStatus = (typeof DASHBOARD_STATUSES)[number];
