// core__0049: one-time COEXISTENCE backfill of the existing single-id dashboard
// rows into the per-entity multi-dashboard model + non-removable "Overview"
// default (cinatra-ai/cinatra#700).
//
// SEQ NOTE: the seq is assigned at MERGE and must be strictly greater than the
// max shipped core__ seq at that time (0047 at authoring). A concurrent W5 lane
// (#1617) claimed 0048, so this file was renumbered 0048 → 0049 at merge-prep
// (0049 > 0047 shipped max; gaps are tolerated). Renumber again to the next free
// seq if 0049 is taken before this merges.
//
// BACKGROUND. Before #700 each surface persisted exactly ONE dashboard per user,
// keyed `system-<surface>:<orgId>:<userId>` (owner_level=user, visibility=private;
// packages/dashboards/src/store/schema.ts). #700 makes dashboards per-entity +
// multi, identified by the composite (entity_type, entity_id, owner_level,
// owner_id, name), with a non-removable is_default "Overview" per (org, entity,
// owner). The three new columns (entity_type, entity_id, is_default) and the
// partial indexes are ADDITIVE and land in the bootstrap DDL
// (buildCreateStoreSchemaQueries); this migration owns the TRANSFORMATIONAL data
// step (renames + sets identity on rows that already hold user data), per
// migrations/README.md.
//
// UP. Absorb each operator-authored `system-<surface>:<org>:<user>` row as that
// entity's Overview: entity_type=<surface>, entity_id=organization_id
// (authoritative column — NOT parsed from the id), is_default=true,
// name='Overview'. Each legacy row maps 1:1 to exactly one Overview: no
// orphaning, no double-rendering.
//   - FAIL-CLOSED on ambiguity (mirrors the runtime upsert guard): only rows
//     with the EXACT canonical id `system-<known-surface>:<organization_id>:
//     <owner_id>` (surface in agents/artifacts/personal/projects/teams/
//     organizations), owner_level = 'user', AND operator-authored (extension_id
//     IS NULL, is_template = false, project_id IS NULL) are mapped. A malformed /
//     wrong-org / wrong-owner / extra-segment / non-user `system-…` row keeps
//     entity_type NULL and is excluded — so it can never become a non-canonical
//     default nor collide with the canonical row on the partial UNIQUE index.
//   - IDEMPOTENT: the `entity_type IS NULL` guard makes a re-run touch zero rows
//     (a mapped row — or any row a later save re-stamps — is never revisited, so
//     a user-renamed/native Overview is never reverted).
//   - SAFE UNDER THE INDEXES: the bootstrap runs BEFORE core migrations (see
//     migrations/README.md "How migrations run"), so the partial UNIQUE indexes
//     dashboards_entity_default_uniq / dashboards_entity_name_uniq already exist
//     and enforce as this UPDATE commits. The 1:1 mapping (each id is unique per
//     surface/org/user) cannot produce a duplicate default or name, so it can
//     never violate them.
//
// DOWN. NO-OP (parity with core__0013). After up(), a MIGRATED Overview
// (is_default + name='Overview' + entity_type in the surface set) is
// INDISTINGUISHABLE from a NATIVE Overview created later by the service's
// ensureOverview (same is_default + same name + same entity_type). Nulling the
// identity fields back would therefore corrupt native Overviews created after
// this migration, so the revert is intentionally a no-op; the ledger row still
// records that the migration ran.
//
// Plain ESM on purpose: imported by the CLI runner, by src/lib (Next bundles
// it), and by vitest. Unqualified names ride the runner's session search_path
// (the app schema, SUPABASE_SCHEMA); the exported builder accepts an explicit
// schema so the integration test can run the SAME SQL against a throwaway schema.

/**
 * The six live surfaces whose existing single-id rows this migration absorbs.
 * MUST stay in sync with MIGRATABLE_SURFACE_ENTITY_TYPES in
 * packages/dashboards/src/store/entity-identity.ts (pinned by
 * entity-identity.test.ts).
 */
export const MIGRATABLE_SURFACES = [
  "agents",
  "artifacts",
  "personal",
  "projects",
  "teams",
  "organizations",
];

/**
 * Build the coexistence backfill UPDATE. Unqualified (search_path-driven) when
 * `schema` is omitted — the production runner path; qualified when a schema is
 * given — the integration-test path.
 * @param {string} [schema]
 * @returns {string}
 */
export function buildEntityOverviewBackfillSql(schema) {
  const tbl = schema ? `"${schema.replaceAll('"', '""')}"."dashboards"` : "dashboards";
  const inList = MIGRATABLE_SURFACES.map((s) => `'system-${s}'`).join(",");
  // FAIL-CLOSED, mirroring the runtime upsert guard: absorb ONLY the EXACT
  // canonical shape `system-<known-surface>:<organization_id>:<owner_id>` on a
  // user-owned row. The single equality `id = split_part(id,':',1) ||
  // ':' || organization_id || ':' || owner_id` reconstructs the canonical id
  // from the row's own authoritative columns, so it rejects in one shot: a
  // missing/short segment (system-agents, system-agents:x), a wrong-org or
  // wrong-owner segment, and any extra 4th segment. `owner_level = 'user'` and
  // the surface IN-list complete the shape. A non-canonical `system-…` row is
  // left entity_type NULL (excluded), so it can never become a non-canonical
  // default and can never collide with the canonical row on the partial UNIQUE
  // default index.
  return `UPDATE ${tbl}
     SET entity_type = regexp_replace(split_part(id, ':', 1), '^system-', ''),
         entity_id   = organization_id,
         is_default  = true,
         name        = 'Overview'
   WHERE entity_type IS NULL
     AND extension_id IS NULL
     AND is_template = false
     AND project_id IS NULL
     AND owner_level = 'user'
     AND split_part(id, ':', 1) IN (${inList})
     AND id = split_part(id, ':', 1) || ':' || organization_id || ':' || owner_id`;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(buildEntityOverviewBackfillSql());
}

// node-pg-migrate calls `down(pgm)`; this migration's revert is intentionally a
// no-op (a migrated Overview is indistinguishable from a natively-created one),
// so it takes no parameter (extra args are ignored by JS).
export function down() {
  // No-op: see the DOWN note in the header. The ledger row records the run.
}
