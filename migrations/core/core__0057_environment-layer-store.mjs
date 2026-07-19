// core__0057 — durable L1 environment-layer store (exec-plane S3 A2,
// cinatra#1708; epic #1705).
//
// Two brand-new tables: `environment_layers` (content-addressed L1 cache
// entries) and `environment_layer_references` (org-scoped recipe→layer
// references). The exec-plane `EnvironmentLayerCache` runs over an injectable
// `EnvironmentLayerStore`; the durable Postgres store these tables back makes
// the cache CROSS-PROCESS (a later process reuses an earlier build; the
// retention GC / lifecycle reference drops share one source of truth) — the
// precondition for the S3 GC/teardown criteria (AC1 reuse, AC3/AC6 lifecycle).
//
// CONSTRAINTS the DB enforces:
//   - environment_layers_recipe_partition_uniq — UNIQUE (recipe_key, partition):
//     one recipe may exist as an instance-shared layer AND one-or-more
//     org-partitioned layers; one org's UPSERT never clobbers another's.
//     `partition` is NOT NULL (`'instance'` sentinel), so no nullable-column
//     duplicate hazard.
//   - environment_layer_references_dedup_uniq — UNIQUE NULLS NOT DISTINCT over
//     (recipe_key, org_id, holder_package_name, holder_template_id,
//     holder_version_id): the holder columns are nullable (packaged vs project
//     agent); NULLS NOT DISTINCT (PG15+) makes two refs that both leave a
//     holder column NULL collide, reproducing the in-memory addReference dedup.
//
// NO foreign keys ON PURPOSE (the artifact_uninstall_operations / dispatch-
// ledger precedent): durable references outlive the referencing install rows;
// the recipe/holder ids are validated at WRITE time, not FK-enforced at rest.
//
// ADDITIVE (brand-new empty tables + their indexes; migrations/README.md
// "Additive") — no artifact is REQUIRED. Shipped anyway (the core__0037/0047/
// 0055 precedent) to keep the fresh-bootstrap and operator-upgrade paths
// aligned. The DDL MIRRORS the idempotent bootstrap
// (buildCreateStoreSchemaQueries → environmentLayerStoreSchemaQueries, the
// pure-strings leaf src/lib/execution/environment-layer-schema.ts, spread in the
// SAME PR) — a no-op on a bootstrap-seeded schema, ledger-faked on a fresh
// install, executed by `db migrate` on an existing deployment. Unqualified names
// ride the runner's search_path (the app schema); metadata-only DDL on empty
// tables, no noTransaction().
//
// SEQ IS PROVISIONAL: shipped max on origin/main at build time is core__0056
// (purge-retired-object-types); this takes the next free 0057. Migration seq is
// assigned at MERGE — a concurrent lane may land 0057 first, in which case a
// rename-only renumber is normal. migrations/** is HIGH-RISK (owner approval);
// the lane never merges.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const environmentLayerStoreDdlSql = `
  CREATE TABLE IF NOT EXISTS environment_layers (
    id                  text PRIMARY KEY,
    recipe_key          text NOT NULL,
    spec_key            text NOT NULL,
    image_ref           text NOT NULL,
    image_digest        text NOT NULL,
    partition           text NOT NULL,
    provenance          jsonb NOT NULL,
    built_at_ms         bigint NOT NULL,
    last_used_at_ms     bigint NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS environment_layers_recipe_partition_uniq
    ON environment_layers (recipe_key, partition);
  CREATE INDEX IF NOT EXISTS environment_layers_spec_key_idx
    ON environment_layers (spec_key);
  CREATE INDEX IF NOT EXISTS environment_layers_last_used_idx
    ON environment_layers (last_used_at_ms);

  CREATE TABLE IF NOT EXISTS environment_layer_references (
    id                    text PRIMARY KEY,
    recipe_key            text NOT NULL,
    org_id                text NOT NULL,
    holder_package_name   text,
    holder_template_id    text,
    holder_version_id     text
  );
  CREATE UNIQUE INDEX IF NOT EXISTS environment_layer_references_dedup_uniq
    ON environment_layer_references
    (recipe_key, org_id, holder_package_name, holder_template_id, holder_version_id)
    NULLS NOT DISTINCT;
  CREATE INDEX IF NOT EXISTS environment_layer_references_recipe_idx
    ON environment_layer_references (recipe_key);
  CREATE INDEX IF NOT EXISTS environment_layer_references_holder_idx
    ON environment_layer_references (holder_package_name, org_id);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(environmentLayerStoreDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: both tables are fresh additions, so dropping them restores the
  // exact pre-0057 shape on any lineage (indexes ride the table drops). HONEST
  // COST: any cached-layer / reference state is lost — an operator-initiated
  // `--down` deliberately accepts that (the store carries no data on a fresh
  // install and every layer is re-derivable by rebuilding from the durable
  // recipe; references re-materialize lazily at the next run-per-install).
  pgm.sql(`DROP TABLE IF EXISTS environment_layer_references;`);
  pgm.sql(`DROP TABLE IF EXISTS environment_layers;`);
}
