// Extracted bootstrap-DDL string leaves for `drizzle-store.ts`.
//
// This module is a small collection of pure string builders with ZERO imports
// (a synchronous leaf, safe for `drizzle-store.ts`'s synchronous `require()`
// composition; see the postgres-sync-leaf-imports test). Each exported function
// returns DDL `{ text }[]` spread into `buildCreateStoreSchemaQueries` so a fresh
// DB provisions the shape (per migrations/README.md). The DDL lives HERE rather
// than inline because drizzle-store.ts is a baselined file-size-ratchet
// bottleneck at its ceiling — AND because keeping every such leaf in ONE already
// route-graph-counted module (rather than one file per concern) keeps the locked
// routes' reachable first-party graph UNCHANGED (no new node per DDL extraction).
// The file name is retained (not renamed) so the `**/extension-*grant*`
// high-risk-path glob keeps covering the grant DDL below.
//
// Contents:
//   - capabilityOwnershipGrantSchemaQueries — the S0 capability-ownership grant
//     table + anti-squat indexes (a NET-NEW table; additive, no migration).
//   - versionIdentitySchemaQueries — the cinatra#1040 S1 version-identity
//     evolution of installed_extension + extension_install_ops (transformational;
//     ships with migrations/core/core__0022 — see that function's own note).
//   - projectDispatchSchemaQueries — the cinatra#1032 dynamic-dispatch
//     primitive's dispatch-attempt ledger + project lease (NET-NEW tables;
//     additive, ships with migrations/core/core__0024 per the core__0007
//     keep-paths-aligned precedent).

/** DDL for the admin-approved `extension_capability_ownership_grant` table +
 * its anti-squat partial unique indexes. Spread into
 * `buildCreateStoreSchemaQueries`. */
export function capabilityOwnershipGrantSchemaQueries(schemaName: string): { text: string }[] {
  return [
    // Runtime installer — admin-approved CAPABILITY-OWNERSHIP grants (the
    // capability-ownership grant, S0). Decides WHICH runtime-installed package
    // OWNS a credential-store token key (`connector_config:<token_config_key>`,
    // e.g. the widget-auth store). A package self-declaring
    // `cinatra.widgetStream.auth.tokenConfigKey` does NOT, by that declaration
    // alone, become the trusted owner — ownership is an admin-approved grant
    // (auto-approved ONLY for a `trusted-signed` install, the same capability
    // split as host ports / host DDL). manifest_binding_hash resets an approval
    // to pending when the declared claim changes; status gates resolution.
    // Modeled on `extension_host_port_grant` — no net-new crypto.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."extension_capability_ownership_grant" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      package_name text NOT NULL,
      org_id text,
      token_config_key text NOT NULL,
      manifest_binding_hash text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      approved_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (package_name, org_id, token_config_key)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS extension_capability_ownership_grant_token_idx ON "${schemaName.replaceAll('"', '""')}"."extension_capability_ownership_grant" (token_config_key, org_id)` },
    // Global-scope (org_id IS NULL) uniqueness of a package's grant per token
    // key: the table UNIQUE(package_name, org_id, token_config_key) does NOT
    // dedupe NULL org_id (SQL NULLs are distinct), so a partial index enforces one
    // global row per (package, token key).
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_capability_ownership_grant_pkg_token_global_uniq ON "${schemaName.replaceAll('"', '""')}"."extension_capability_ownership_grant" (package_name, token_config_key) WHERE org_id IS NULL` },
    // ANTI-SQUATTING (the capability-ownership grant design headline): at most
    // ONE approved owner per (token key, org). Two approved owners for the same
    // token store is a write-time impossibility — a squatting approval fails with
    // a unique violation, never a silent second owner. A plain partial index does
    // NOT constrain org_id IS NULL (NULLs are distinct), so the global scope has
    // its own approved-uniqueness index below.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_capability_ownership_grant_approved_token_uniq ON "${schemaName.replaceAll('"', '""')}"."extension_capability_ownership_grant" (token_config_key, org_id) WHERE status = 'approved' AND org_id IS NOT NULL` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_capability_ownership_grant_approved_token_global_uniq ON "${schemaName.replaceAll('"', '""')}"."extension_capability_ownership_grant" (token_config_key) WHERE status = 'approved' AND org_id IS NULL` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'extension_capability_ownership_grant'
            AND constraint_name = 'extension_capability_ownership_grant_status_check'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_capability_ownership_grant"
            ADD CONSTRAINT extension_capability_ownership_grant_status_check
            CHECK (status IN ('pending', 'approved', 'revoked'));
        END IF;
      END $$;` },
  ];
}

/**
 * DDL for the version-identity evolution of `installed_extension` and
 * `extension_install_ops` (cinatra#1040 S1). Spread into
 * `buildCreateStoreSchemaQueries` AFTER both tables' CREATE statements (every
 * statement references its table by name).
 *
 * This bootstrap mirrors migration `migrations/core/core__0022_extension-version-identity.mjs`
 * idempotently: a FRESH database is born at the target shape (and ledger-fakes
 * the migration chain), and an UPGRADED database converges through this pass
 * before the runner executes 0022 as a no-op. Every statement is IF [NOT] EXISTS
 * / guarded, so re-running on any lineage is a no-op. The change is
 * transformational (a NOT NULL column + new unique indexes over tables that
 * already hold rows), so it ALSO ships the core__0022 runner module + its
 * manifest entry — the schema-migration / upgrade-proof gates' required artifact.
 */
export function versionIdentitySchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier-position quote
  return [
    // -------------------------------------------------------------------------
    // installed_extension — VERSION becomes part of the storage identity, and
    // is_default marks the one version that owns the package's unversioned
    // global name (cinatra#1040 S1).
    // -------------------------------------------------------------------------
    // version: additive nullable first (safe on a populated table), backfilled
    // from the source's own version, then constrained NOT NULL. verdaccio /
    // bundled sources carry `source.version`; github / local sources carry NONE
    // — the COALESCE floor '0.0.0' for those is LOAD-BEARING (a NULL version
    // could never satisfy the NOT NULL identity column).
    { text: `ALTER TABLE "${q}"."installed_extension" ADD COLUMN IF NOT EXISTS version text` },
    { text: `UPDATE "${q}"."installed_extension" SET version = COALESCE(source->>'version', '0.0.0') WHERE version IS NULL` },
    { text: `ALTER TABLE "${q}"."installed_extension" ALTER COLUMN version SET NOT NULL` },
    // is_default: NOT NULL DEFAULT true self-backfills every existing row to the
    // default (each is the sole row for its identity today — see the one-default
    // index note below), so no separate backfill statement is needed.
    { text: `ALTER TABLE "${q}"."installed_extension" ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT true` },
    // Identity now includes version: drop the pre-#1040 identity indexes (keyed
    // on org/owner/package WITHOUT version) and recreate them WITH version under
    // new names (a same-name CREATE IF NOT EXISTS would skip the rebuild on an
    // upgraded DB that still carries the old-shape index).
    { text: `DROP INDEX IF EXISTS "${q}".installed_extension_identity_org_idx` },
    { text: `DROP INDEX IF EXISTS "${q}".installed_extension_identity_platform_idx` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS installed_extension_identity_org_v_idx
  ON "${q}"."installed_extension"
    (organization_id, owner_level, owner_id, package_name, version)
  WHERE organization_id IS NOT NULL` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS installed_extension_identity_platform_v_idx
  ON "${q}"."installed_extension"
    (owner_level, owner_id, package_name, version)
  WHERE organization_id IS NULL` },
    // ONE DEFAULT PER (org, owner, package): at most one is_default row per
    // identity-minus-version. SAFE to build on existing data because the
    // pre-#1040 identity indexes were unique on (org, owner, package) WITHOUT
    // version, so every existing row is the SOLE row for its identity and its
    // self-backfilled is_default=true can never collide. Postgres treats NULLs
    // as distinct under a plain unique, so the org-NULL scope needs its own twin.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS installed_extension_one_default_org_idx
  ON "${q}"."installed_extension"
    (organization_id, owner_level, owner_id, package_name)
  WHERE is_default AND organization_id IS NOT NULL` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS installed_extension_one_default_platform_idx
  ON "${q}"."installed_extension"
    (owner_level, owner_id, package_name)
  WHERE is_default AND organization_id IS NULL` },
    // -------------------------------------------------------------------------
    // extension_install_ops — re-key the append-only finalized-anchor
    // uniqueness (cinatra#158 / core__0005) to include version (cinatra#1040 S1),
    // so one finalized op is the anchor PER (package, org, version).
    // -------------------------------------------------------------------------
    // NOT NULL DEFAULT '0.0.0' (no source column to derive from). A NULLABLE
    // version would be a correctness trap: SQL treats NULLs as distinct under a
    // unique index, so two NULL-version finalized rows for one scope would BOTH
    // be admitted — defeating the single-anchor invariant. The '0.0.0' floor
    // preserves it and matches the installed_extension floor.
    { text: `ALTER TABLE "${q}"."extension_install_ops" ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT '0.0.0'` },
    { text: `DROP INDEX IF EXISTS "${q}".extension_install_ops_one_finalized` },
    { text: `DROP INDEX IF EXISTS "${q}".extension_install_ops_one_finalized_global` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_install_ops_one_finalized_v
  ON "${q}"."extension_install_ops" (package_name, org_id, version) WHERE phase = 'finalized'` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_install_ops_one_finalized_v_global
  ON "${q}"."extension_install_ops" (package_name, version) WHERE phase = 'finalized' AND org_id IS NULL` },
  ];
}

// ---------------------------------------------------------------------------
// Dynamic-dispatch primitive storage (cinatra#1032 deliverable 2).
// Two brand-new ADDITIVE tables (companion migration core__0024 ships the same
// DDL for the operator-upgrade path per the core__0007 precedent; the Drizzle
// mirrors live in packages/agents/src/schema.ts):
//   project_dispatch_attempts — the dispatch-attempt LEDGER: one row per
//   deliberate dispatch attempt, UNIQUE (org_id, item_natural_key,
//   action_version); written AHEAD of createAgentRun with the deterministically
//   derived idempotency_key passed VERBATIM, so a crashed tick re-converges
//   onto the SAME child run instead of dispatching a duplicate. run_id is
//   provenance only — deliberately NO foreign key (the ledger is append-only
//   history that outlives the operational run row). The immutable attempt
//   identity includes the worker binding (role, package, version-constraint
//   fingerprint).
//   project_leases — the project-level lease (single active tick per PM
//   project scope), keyed (org_id, project_ref), heartbeat/expiry columns and
//   a fencing `version` bumped on every (re)acquisition.
// ---------------------------------------------------------------------------

/** project_dispatch_attempts + project_leases CREATE TABLE / CREATE INDEX DDL.
 * Spread into buildCreateStoreSchemaQueries after the agent_run_pm_links
 * block. */
export function projectDispatchSchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""');
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."project_dispatch_attempts" (
      id text PRIMARY KEY,
      org_id text NOT NULL,
      project_ref text NOT NULL,
      item_natural_key text NOT NULL,
      action_version integer NOT NULL,
      worker_role text NOT NULL,
      worker_package text NOT NULL,
      worker_version_constraint text NOT NULL,
      idempotency_key text NOT NULL,
      run_id text,
      status text NOT NULL DEFAULT 'pending',
      error text,
      version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT project_dispatch_attempts_status_check
        CHECK (status IN ('pending', 'dispatched', 'failed')),
      CONSTRAINT project_dispatch_attempts_action_version_check
        CHECK (action_version >= 0)
    )`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS project_dispatch_attempts_item_action_uniq ON "${q}"."project_dispatch_attempts" (org_id, item_natural_key, action_version)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS project_dispatch_attempts_project_idx ON "${q}"."project_dispatch_attempts" (org_id, project_ref)`,
    },
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."project_leases" (
      org_id text NOT NULL,
      project_ref text NOT NULL,
      holder_id text NOT NULL,
      acquired_at timestamptz NOT NULL DEFAULT now(),
      heartbeat_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      version integer NOT NULL DEFAULT 1,
      PRIMARY KEY (org_id, project_ref)
    )`,
    },
  ];
}
