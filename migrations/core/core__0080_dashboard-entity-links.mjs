// core__0080 — dashboard scope-collection SECONDARY LISTINGS junction
// (cinatra#1897 B4; the ratified design spec at design@bb9230d9b,
// `specs/app-artifacts.html` §IX "The scope Dashboards tab — listings &
// add-to-scope").
//
// ONE brand-new table, `dashboard_entity_links`, backing the add-to-scope side
// of the scope Dashboards tab. A dashboard's CANONICAL HOME stays the singular
// `(entity_type, entity_id)` on `dashboards` (§VIII); this junction adds a
// *separate listing relation* — a dashboard listed on a team's / project's /
// organization's Dashboards tab as a reference, never a second home. A listing
// opens the SAME canonical surface / artifact detail the home does, so the home
// axis, the Overview default-uniqueness index and the per-entity name-uniqueness
// index on `dashboards` are all UNTOUCHED by a listing.
//
//   `dashboard_entity_links` — one row per (dashboard, scope) LISTING.
//     dashboard_id     → the listed dashboard (FK ON DELETE CASCADE: a deleted
//                        dashboard drops its listings — a listing is meaningless
//                        without its dashboard).
//     entity_type      → the scope kind the dashboard is LISTED in, the three
//                        shared add-to-scope scopes ONLY: 'team' | 'organization'
//                        | 'project' (a personal user scope and the whole-
//                        workspace scope are not add-to-scope targets, §IX).
//     entity_id        → the scope instance id (team id / org id / project id).
//     organization_id  → the scope's tenant, denormalized from the dashboard's
//                        org at add time so a per-scope listing query stays
//                        tenant-scoped without a join.
//     created_by       → the scope manager who added the listing (attribution).
//   UNIQUE (dashboard_id, entity_type, entity_id) — one listing per (dashboard,
//     scope): makes add idempotent (ON CONFLICT DO NOTHING) and remove exact.
//   INDEX (entity_type, entity_id, organization_id) — "the dashboards listed in
//     this scope" (the tab's read).
//   INDEX (dashboard_id) — "the scopes a dashboard is listed in" (scope chips /
//     the FK cascade).
//
// ADDITIVE (one brand-new empty table + indexes; migrations/README.md
// "Additive") — no artifact is REQUIRED. Shipped anyway (the core__0072/0058/0055
// precedent) so fresh-bootstrap and operator-upgrade paths stay aligned. The DDL
// MIRRORS the idempotent bootstrap leaf in src/lib/drizzle-store.ts
// (buildCreateStoreSchemaQueries, the `dashboard_entity_links` CREATE + three
// indexes, spread in the SAME PR) — a no-op on a bootstrap-seeded schema,
// ledger-faked on a fresh install, executed by `db migrate` on an existing
// deployment. Unqualified names ride the runner's search_path (the app schema);
// metadata-only DDL on an empty table, no noTransaction().
//
// SEQ 0080 — strictly greater than the max seq VISIBLE across origin/main
// (core__0075_widget-auth-token-keys-canonical, merged) AND every open PR: PR
// #1986 currently carries core__0073/0074 (assistants W5) which its own
// renumber-at-merge bumps to core__0076/0077 (0075 having landed on main after
// #1986 opened), so 0080 clears both the merged tip AND #1986's post-renumber
// pair. Migration seq is assigned at MERGE: a concurrent lane may land an
// intervening seq first, in which case a rename-only renumber is normal (this is
// FLAGGED for the coordinator's train; sequence gaps are tolerated by the
// runner). migrations/** is HIGH-RISK (owner approval required); the lane never
// merges.
//
// DOWN. Reversible in shape: drops the one fresh table (its indexes ride the
// drop). HONEST COST: any listings an operator created are lost — an
// operator-initiated `--down` accepts that (the table carries no data on a fresh
// install, and a canonical home is never a listing so no home is ever lost).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const dashboardEntityLinksDdlSql = `
  CREATE TABLE IF NOT EXISTS dashboard_entity_links (
    id              text PRIMARY KEY,
    dashboard_id    text NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    entity_type     text NOT NULL CHECK (entity_type IN ('team','organization','project')),
    entity_id       text NOT NULL,
    organization_id text NOT NULL,
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS dashboard_entity_links_uniq
    ON dashboard_entity_links (dashboard_id, entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS dashboard_entity_links_scope_idx
    ON dashboard_entity_links (entity_type, entity_id, organization_id);
  CREATE INDEX IF NOT EXISTS dashboard_entity_links_dashboard_idx
    ON dashboard_entity_links (dashboard_id);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(dashboardEntityLinksDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: a fresh additive table. Drop it (indexes ride the drop). HONEST
  // COST: any operator-created listings are lost — an operator `--down` accepts
  // that (empty on a fresh install; a canonical home is never a listing, so no
  // dashboard home is ever lost).
  pgm.sql(`DROP TABLE IF EXISTS dashboard_entity_links;`);
}
