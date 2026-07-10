// core__0022 — VERSION IDENTITY for installed extensions (cinatra-ai/cinatra#1040
// S1, the storage half). Adds a package VERSION to the installed_extension
// identity so multiple versions of one package can be installed side by side,
// with exactly one marked default (the version that owns the package's
// unversioned global name), and re-keys the extension_install_ops finalized
// anchor uniqueness to include version.
//
// installed_extension:
//   • version text NOT NULL — backfilled from the row's own source
//     (COALESCE(source->>'version','0.0.0')). verdaccio/bundled sources carry
//     source.version; github/local sources carry none, so the '0.0.0' floor is
//     load-bearing (a NULL could never satisfy the NOT NULL identity column).
//   • is_default boolean NOT NULL DEFAULT true — self-backfills every existing
//     row to the default.
//   • the two identity partial-unique indexes gain version (new _v names; the
//     old names are dropped so the rebuild is unambiguous on an upgraded DB).
//   • a new one-default-per-identity partial-unique index pair: at most one
//     is_default row per (org, owner, package). SAFE on existing data because
//     the pre-#1040 identity indexes were unique on (org, owner, package)
//     WITHOUT version — every existing row is the SOLE row for its identity, so
//     its self-backfilled default can never collide.
//
// extension_install_ops (append-only journal, precedent core__0005):
//   • version text NOT NULL DEFAULT '0.0.0' (no source column to derive from;
//     a nullable version would let NULL-distinct admit two finalized rows per
//     scope — the '0.0.0' floor preserves the single-anchor invariant).
//   • the finalized-anchor uniqueness (package_name, org_id) [+ the org-NULL
//     global twin] gains version.
//
// WHY A MIGRATION (transformational half). The columns alone are additive — the
// bootstrap DDL (versionIdentitySchemaQueries, spread into
// buildCreateStoreSchemaQueries, same PR) adds them via ADD COLUMN IF NOT
// EXISTS, so a fresh install is born at the target shape and ledger-fakes this
// chain. But a NOT NULL identity column plus new UNIQUE indexes over tables that
// already hold rows in a DEPLOYED database is transformational — it needs this
// module on the operator upgrade path (`cinatra db migrate`, which always
// executes; see migrations/README.md).
//
// DEPLOY BOUNDARY (coordinated, NON-rolling — as core__0005). A pre-0022 app
// process inserts install rows without a version. installed_extension.version is
// NOT NULL with no default, so a pre-0022 INSERT fails closed (never a silent
// NULL); extension_install_ops.version defaults to '0.0.0', so a pre-0022
// finalize writes '0.0.0' and the re-keyed unique index still forces supersession
// of the prior '0.0.0' anchor (no duplicate-anchor escape). Apply with old
// writers drained (the standard release boundary — cinatra is a single writable
// install region per deploy and the install path is serialized per package).
//
// IDEMPOTENT / LINEAGE-TOLERANT. Columns are IF NOT EXISTS; the backfill only
// touches NULLs; SET NOT NULL is a no-op once satisfied; every index is
// DROP/CREATE IF [NOT] EXISTS. Re-running against an already-migrated schema — or
// the bootstrap-produced fresh shape — is a no-op. Unqualified names ride the
// runner's search_path (the app schema), what keeps worktree/branch schemas
// working.
//
// down() is a true reverse: drop the new indexes, restore the pre-#1040 identity
// + finalized-anchor indexes, then drop the columns. A revert loses the version
// / is_default identity data by design (a structural addition, not a rename).

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // --- installed_extension -------------------------------------------------
  pgm.sql(`ALTER TABLE installed_extension ADD COLUMN IF NOT EXISTS version text;`);
  pgm.sql(
    `UPDATE installed_extension SET version = COALESCE(source->>'version', '0.0.0') WHERE version IS NULL;`,
  );
  pgm.sql(`ALTER TABLE installed_extension ALTER COLUMN version SET NOT NULL;`);
  pgm.sql(
    `ALTER TABLE installed_extension ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT true;`,
  );

  // Identity indexes gain version (drop the pre-#1040 names, recreate as _v).
  pgm.sql(`DROP INDEX IF EXISTS installed_extension_identity_org_idx;`);
  pgm.sql(`DROP INDEX IF EXISTS installed_extension_identity_platform_idx;`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS installed_extension_identity_org_v_idx
    ON installed_extension (organization_id, owner_level, owner_id, package_name, version)
    WHERE organization_id IS NOT NULL;`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS installed_extension_identity_platform_v_idx
    ON installed_extension (owner_level, owner_id, package_name, version)
    WHERE organization_id IS NULL;`);

  // One default per (org, owner, package).
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS installed_extension_one_default_org_idx
    ON installed_extension (organization_id, owner_level, owner_id, package_name)
    WHERE is_default AND organization_id IS NOT NULL;`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS installed_extension_one_default_platform_idx
    ON installed_extension (owner_level, owner_id, package_name)
    WHERE is_default AND organization_id IS NULL;`);

  // --- extension_install_ops (re-key the finalized anchor uniqueness) ------
  pgm.sql(
    `ALTER TABLE extension_install_ops ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT '0.0.0';`,
  );
  pgm.sql(`DROP INDEX IF EXISTS extension_install_ops_one_finalized;`);
  pgm.sql(`DROP INDEX IF EXISTS extension_install_ops_one_finalized_global;`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS extension_install_ops_one_finalized_v
    ON extension_install_ops (package_name, org_id, version) WHERE phase = 'finalized';`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS extension_install_ops_one_finalized_v_global
    ON extension_install_ops (package_name, version) WHERE phase = 'finalized' AND org_id IS NULL;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Restore extension_install_ops finalized-anchor uniqueness (pre-version key).
  pgm.sql(`DROP INDEX IF EXISTS extension_install_ops_one_finalized_v;`);
  pgm.sql(`DROP INDEX IF EXISTS extension_install_ops_one_finalized_v_global;`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS extension_install_ops_one_finalized
    ON extension_install_ops (package_name, org_id) WHERE phase = 'finalized';`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS extension_install_ops_one_finalized_global
    ON extension_install_ops (package_name) WHERE phase = 'finalized' AND org_id IS NULL;`);
  pgm.sql(`ALTER TABLE extension_install_ops DROP COLUMN IF EXISTS version;`);

  // Restore installed_extension identity indexes (pre-version key) and drop the
  // one-default + version identity indexes and the new columns.
  pgm.sql(`DROP INDEX IF EXISTS installed_extension_one_default_org_idx;`);
  pgm.sql(`DROP INDEX IF EXISTS installed_extension_one_default_platform_idx;`);
  pgm.sql(`DROP INDEX IF EXISTS installed_extension_identity_org_v_idx;`);
  pgm.sql(`DROP INDEX IF EXISTS installed_extension_identity_platform_v_idx;`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS installed_extension_identity_org_idx
    ON installed_extension (organization_id, owner_level, owner_id, package_name)
    WHERE organization_id IS NOT NULL;`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS installed_extension_identity_platform_idx
    ON installed_extension (owner_level, owner_id, package_name)
    WHERE organization_id IS NULL;`);
  pgm.sql(`ALTER TABLE installed_extension DROP COLUMN IF EXISTS is_default;`);
  pgm.sql(`ALTER TABLE installed_extension DROP COLUMN IF EXISTS version;`);
}
