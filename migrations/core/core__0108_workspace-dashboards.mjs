// core__0108: WORKSPACE DASHBOARDS (cinatra#2811, per-scope surfaces S5).
//
// The whole-workspace scope gets its own per-user dashboards and becomes a
// reference target for dashboards homed in the scopes below it. Three storage
// changes carry that, and they belong to one concern, so they ship together:
//
// 1. ORGANIZATION-INDEPENDENT DASHBOARD ROWS. A workspace dashboard is keyed
//    `(entity_type='workspace', entity_id='__workspace__', owner_level='user',
//    owner_id=<user>)` with NO organization: the workspace sits above every
//    organization, so its rows must read the same whichever organization the
//    session has active. `dashboards.organization_id` therefore drops NOT NULL,
//    and two CHECKs bind the exception tightly:
//      - `dashboards_workspace_entity_org_check`: organization_id is NULL
//        exactly when entity_type is 'workspace'; no other row may lose its
//        tenant, and no workspace row may carry one;
//      - `dashboards_workspace_entity_shape_check`: a workspace row is the
//        user-owned `__workspace__` entity, never project-refined, never a
//        template. The entity id is compared NULL-safely, so a NULL id cannot
//        pass the CHECK as UNKNOWN (and slip past the unique twins with it).
//    The per-entity partial unique indexes are keyed on organization_id, and
//    NULLs are distinct in a unique index, so they cannot hold "one Overview"
//    or "one name" for an org-NULL row. Their ORG-NULL TWINS are added here,
//    each partial on `organization_id IS NULL`, so a twin can never see (or
//    collide with) an organization row, and an organization index can never see
//    a workspace row.
//
// 2. WORKSPACE REFERENCES. `dashboard_entity_links.entity_type` admits
//    'workspace' beside team / organization / project, and a workspace link
//    names the one `__workspace__` scope. The link keeps its NOT NULL
//    organization_id: for a workspace link it is the TARGET dashboard's home
//    organization, which is what the listing authority (organization admins
//    curate the links whose target's home organization is theirs) and the
//    tenant fence of the read both key on.
//
// 3. THE EVERYONE-GRANT. A platform administrator may mark a workspace
//    reference visible to everyone: `workspace_read_granted` plus who granted
//    it and when. `dashboard_entity_links_workspace_grant_check` requires the
//    metadata exactly when the grant is set, and forbids the grant on any link
//    that is not a workspace link, so a team / organization / project listing
//    can never carry it. The grant's history lives in `audit_events`, not here:
//    revoking clears the live columns and leaves the audit trail untouched.
//
// PRECONDITION. Before this migration no writer could produce an
// entity_type='workspace' row (the service refused the type), so no deployed row
// should violate the new CHECKs. A row that does was written around the service;
// the migration refuses LOUDLY, naming the count and the remedy, instead of
// rewriting or deleting data it cannot reason about. On a schema already at the
// target shape the check finds nothing (a valid workspace row passes it), so a
// re-run is a no-op.
//
// IDEMPOTENT throughout: DROP NOT NULL is a no-op when already nullable, every
// constraint is added under a duplicate_object guard, every index is IF NOT
// EXISTS, and the links CHECK is replaced only while its definition still lacks
// 'workspace'. The same statements are the fresh-install bootstrap half, so a
// bootstrap-created schema and an upgraded one converge on one shape.
//
// SEQ 0108: strictly greater than the max shipped seq on the default branch
// (core__0107). 0106 is claimed by an open change and skipped; the convention
// reads not-already-taken rather than highest (cinatra#3029), so the gap is
// legal. migrations/** is HIGH-RISK: maintainer approval required; the lane
// never merges.
//
// DOWN. Reverses the shape. The honest cost is stated rather than hidden: every
// workspace dashboard and every workspace reference is DELETED on the way down,
// because the narrower shape has no place for them (a NOT NULL organization and
// a links CHECK without 'workspace'). No organization dashboard and no
// team / organization / project listing is touched.

/** The org-NULL workspace entity id every workspace dashboard and workspace
 *  reference names. Mirrors `WORKSPACE_DASHBOARD_ENTITY_ID` in
 *  packages/dashboards/src/store/entity-identity.ts (pinned by a parity test). */
export const WORKSPACE_ENTITY_ID = "__workspace__";

/** Refuse loudly when a row already violates the new shape (see the header). */
export const workspaceDashboardsPreconditionSql = `
  DO $$
  DECLARE bad_dashboards bigint; bad_links bigint;
  BEGIN
    SELECT count(*) INTO bad_dashboards FROM dashboards
     WHERE (entity_type = 'workspace' AND organization_id IS NOT NULL)
        OR (entity_type = 'workspace' AND (entity_id IS DISTINCT FROM '${WORKSPACE_ENTITY_ID}'
              OR owner_level <> 'user' OR project_id IS NOT NULL OR is_template));
    IF bad_dashboards > 0 THEN
      RAISE EXCEPTION 'core__0108: % dashboards row(s) carry entity_type=''workspace'' outside the workspace shape (organization_id NULL, entity_id ''${WORKSPACE_ENTITY_ID}'', owner_level ''user'', no project, not a template). They were written around the dashboards service; correct or remove them, then re-run the migration.', bad_dashboards;
    END IF;
    SELECT count(*) INTO bad_links FROM dashboard_entity_links
     WHERE entity_type NOT IN ('team','organization','project','workspace');
    IF bad_links > 0 THEN
      RAISE EXCEPTION 'core__0108: % dashboard_entity_links row(s) carry an entity_type outside team/organization/project/workspace; correct or remove them, then re-run the migration.', bad_links;
    END IF;
  END $$;
`;

/** Organization-independent dashboard rows: nullability, the two CHECKs, and the
 *  org-NULL twins of the per-entity indexes. */
export const workspaceDashboardRowsSql = `
  ALTER TABLE dashboards ALTER COLUMN organization_id DROP NOT NULL;
  DO $$ BEGIN
    ALTER TABLE dashboards ADD CONSTRAINT dashboards_workspace_entity_org_check
      CHECK ((organization_id IS NULL) = (entity_type IS NOT DISTINCT FROM 'workspace'));
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN
    ALTER TABLE dashboards ADD CONSTRAINT dashboards_workspace_entity_shape_check
      CHECK (entity_type IS DISTINCT FROM 'workspace'
             OR (entity_id IS NOT DISTINCT FROM '${WORKSPACE_ENTITY_ID}' AND owner_level = 'user'
                 AND project_id IS NULL AND is_template = false));
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE INDEX IF NOT EXISTS dashboards_workspace_entity_idx
    ON dashboards (entity_type, entity_id, owner_level, owner_id)
    WHERE entity_type IS NOT NULL AND organization_id IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS dashboards_workspace_entity_default_uniq
    ON dashboards (entity_type, entity_id, owner_level, owner_id)
    WHERE is_default = true AND entity_type IS NOT NULL AND organization_id IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS dashboards_workspace_entity_name_uniq
    ON dashboards (entity_type, entity_id, owner_level, owner_id, name)
    WHERE entity_type IS NOT NULL AND organization_id IS NULL;
`;

/** Workspace references and the everyone-grant on `dashboard_entity_links`. */
export const workspaceReferenceLinksSql = `
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = 'dashboard_entity_links'::regclass
         AND c.conname = 'dashboard_entity_links_entity_type_check'
         AND pg_get_constraintdef(c.oid) LIKE '%workspace%'
    ) THEN
      ALTER TABLE dashboard_entity_links DROP CONSTRAINT IF EXISTS dashboard_entity_links_entity_type_check;
      ALTER TABLE dashboard_entity_links ADD CONSTRAINT dashboard_entity_links_entity_type_check
        CHECK (entity_type IN ('team','organization','project','workspace'));
    END IF;
  END $$;
  DO $$ BEGIN
    ALTER TABLE dashboard_entity_links ADD CONSTRAINT dashboard_entity_links_workspace_scope_check
      CHECK (entity_type <> 'workspace' OR entity_id = '${WORKSPACE_ENTITY_ID}');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  ALTER TABLE dashboard_entity_links ADD COLUMN IF NOT EXISTS workspace_read_granted boolean NOT NULL DEFAULT false;
  ALTER TABLE dashboard_entity_links ADD COLUMN IF NOT EXISTS workspace_read_granted_by text;
  ALTER TABLE dashboard_entity_links ADD COLUMN IF NOT EXISTS workspace_read_granted_at timestamptz;
  DO $$ BEGIN
    ALTER TABLE dashboard_entity_links ADD CONSTRAINT dashboard_entity_links_workspace_grant_check
      CHECK (
        (workspace_read_granted = false
          AND workspace_read_granted_by IS NULL AND workspace_read_granted_at IS NULL)
        OR (workspace_read_granted = true AND entity_type = 'workspace'
          AND workspace_read_granted_by IS NOT NULL AND workspace_read_granted_at IS NOT NULL)
      );
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

/** The whole up-migration, in dependency order. */
export const workspaceDashboardsUpSql = [
  workspaceDashboardsPreconditionSql,
  workspaceDashboardRowsSql,
  workspaceReferenceLinksSql,
].join("\n");

/** The down-migration (see the header for its honest cost). */
export const workspaceDashboardsDownSql = `
  ALTER TABLE dashboard_entity_links DROP CONSTRAINT IF EXISTS dashboard_entity_links_workspace_grant_check;
  ALTER TABLE dashboard_entity_links DROP COLUMN IF EXISTS workspace_read_granted_at;
  ALTER TABLE dashboard_entity_links DROP COLUMN IF EXISTS workspace_read_granted_by;
  ALTER TABLE dashboard_entity_links DROP COLUMN IF EXISTS workspace_read_granted;
  ALTER TABLE dashboard_entity_links DROP CONSTRAINT IF EXISTS dashboard_entity_links_workspace_scope_check;
  DELETE FROM dashboard_entity_links WHERE entity_type = 'workspace';
  ALTER TABLE dashboard_entity_links DROP CONSTRAINT IF EXISTS dashboard_entity_links_entity_type_check;
  ALTER TABLE dashboard_entity_links ADD CONSTRAINT dashboard_entity_links_entity_type_check
    CHECK (entity_type IN ('team','organization','project'));
  DROP INDEX IF EXISTS dashboards_workspace_entity_name_uniq;
  DROP INDEX IF EXISTS dashboards_workspace_entity_default_uniq;
  DROP INDEX IF EXISTS dashboards_workspace_entity_idx;
  DELETE FROM dashboards WHERE organization_id IS NULL;
  ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_workspace_entity_shape_check;
  ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_workspace_entity_org_check;
  ALTER TABLE dashboards ALTER COLUMN organization_id SET NOT NULL;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(workspaceDashboardsUpSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(workspaceDashboardsDownSql);
}
