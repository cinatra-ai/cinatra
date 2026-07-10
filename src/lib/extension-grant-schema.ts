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
//   - dependencyEdgeSchemaQueries — the cinatra#1040 S2 extension_dependency_edge
//     table + the jsonb→edge-rows migration mirror (transformational; ships with
//     migrations/core/core__0025 — see that function's own note).

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

/**
 * DDL for the `extension_dependency_edge` table (cinatra#1040 S2): dependency
 * edges move OFF the `installed_extension.dependencies` row jsonb into
 * first-class rows carrying the declared edge (package / kind / edgeType /
 * versionConstraint / requirement, declared order) PLUS the write-time
 * resolution (`resolved_install_id` — WHICH installed row satisfied the edge —
 * and a free-form `resolution_reason` provenance note). Spread into
 * `buildCreateStoreSchemaQueries` AFTER the installed_extension CREATE (the
 * FKs reference it).
 *
 * This bootstrap mirrors migration `migrations/core/core__0025_extension-dependency-edge.mjs`
 * idempotently (the S1 convention): a FRESH database is born at the target
 * shape — edge table present, NO `dependencies` jsonb column (the
 * installed_extension CREATE above no longer declares it) — and ledger-fakes
 * the chain; an UPGRADED database converges through the guarded DO block below
 * (preflight-validate → backfill with per-declaring-row scoped resolution →
 * drop the jsonb column) before the runner executes 0025 as a no-op. The
 * block only runs while the legacy column exists, so re-running on any
 * lineage is a no-op. The change is transformational (a backfill + a column
 * drop over a table that already holds rows), so it ALSO ships the core__0025
 * runner module + manifest entry — the schema-migration / upgrade-proof
 * gates' required artifact.
 *
 * Resolution rule (the SINGLE rule, mirrored by the canonical store's
 * write-time resolver and the closure engine's name-lookup fallback): the
 * DECLARING row's own-org live (active|locked) row first, then the platform
 * row — a platform-scoped dependent binds only platform rows — preferring the
 * DEFAULT version, deterministic id tie-break. A missing target backfills
 * UNRESOLVED (NULL) so the gates' name-fallback keeps pre-S2 healing
 * semantics.
 */
export function dependencyEdgeSchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier-position quote
  const lit = schemaName.replaceAll("'", "''"); // literal-position quote
  return [
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."extension_dependency_edge" (
  id text PRIMARY KEY,
  dependent_install_id text NOT NULL REFERENCES "${q}"."installed_extension"(id) ON DELETE CASCADE,
  declared_package_name text NOT NULL,
  declared_kind text,
  edge_type text NOT NULL CHECK (edge_type IN ('runtime','install-time','peer')),
  requirement text NOT NULL CHECK (requirement IN ('required','optional')),
  version_constraint jsonb NOT NULL,
  declared_index integer NOT NULL DEFAULT 0,
  resolved_install_id text REFERENCES "${q}"."installed_extension"(id) ON DELETE SET NULL,
  resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)` },
    // One row per manifest-array position (NOT a semantic-dedupe constraint —
    // duplicate declared packages stay representable; the manifest reader owns
    // dedupe). Doubles as the hydration index (dependent, declared order).
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_dependency_edge_dependent_pos_uniq
  ON "${q}"."extension_dependency_edge" (dependent_install_id, declared_index)` },
    // The archive/GC direction: "which edges resolve to THIS install row".
    { text: `CREATE INDEX IF NOT EXISTS extension_dependency_edge_resolved_idx
  ON "${q}"."extension_dependency_edge" (resolved_install_id)` },
    // Transformational mirror of core__0025 (guarded: runs ONLY while the
    // legacy jsonb column still exists — i.e. exactly once per upgraded DB).
    { text: `DO $$
DECLARE bad record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '${lit}' AND table_name = 'installed_extension'
      AND column_name = 'dependencies'
  ) THEN
    -- Preflight: FAIL LOUD on malformed legacy edges BEFORE any destructive
    -- work (silently skipping them and then dropping the source column would
    -- silently weaken the closure gates). STRICT MIRROR of the TS writer's
    -- validateExtensionDependencyShape (manifest-dependencies.ts): non-empty
    -- packageName, no self-edge, enum-valid edgeType/requirement/kind, and a
    -- discriminant-valid versionConstraint ({} or an unknown kind would
    -- hydrate as a constraint that silently bypasses range enforcement).
    -- IS DISTINCT FROM catches MISSING keys (jsonb_typeof(NULL) evades <>).
    SELECT ie.id AS dependent_id, (d.ord - 1)::int AS declared_index INTO bad
    FROM "${q}"."installed_extension" ie
    CROSS JOIN LATERAL jsonb_array_elements(ie.dependencies) WITH ORDINALITY AS d(elem, ord)
    WHERE jsonb_typeof(d.elem) IS DISTINCT FROM 'object'
       OR jsonb_typeof(d.elem->'packageName') IS DISTINCT FROM 'string'
       OR coalesce(d.elem->>'packageName', '') = ''
       OR (d.elem->>'packageName') = ie.package_name
       OR (d.elem->>'edgeType') IS NULL
       OR (d.elem->>'edgeType') NOT IN ('runtime','install-time','peer')
       OR (d.elem->>'requirement') IS NULL
       OR (d.elem->>'requirement') NOT IN ('required','optional')
       OR (d.elem ? 'kind' AND ((d.elem->>'kind') IS NULL
           OR (d.elem->>'kind') NOT IN ('agent','connector','artifact','skill','workflow')))
       OR jsonb_typeof(d.elem->'versionConstraint') IS DISTINCT FROM 'object'
       OR ((
            ((d.elem->'versionConstraint'->>'kind') = 'semver-range'
              AND jsonb_typeof(d.elem->'versionConstraint'->'range') = 'string'
              AND (d.elem->'versionConstraint'->>'range') <> '')
         OR ((d.elem->'versionConstraint'->>'kind') = 'exact'
              AND jsonb_typeof(d.elem->'versionConstraint'->'version') = 'string'
              AND (d.elem->'versionConstraint'->>'version') <> '')
         OR ((d.elem->'versionConstraint'->>'kind') = 'git-ref'
              AND jsonb_typeof(d.elem->'versionConstraint'->'ref') = 'string'
              AND (d.elem->'versionConstraint'->>'ref') <> '')
       ) IS NOT TRUE)
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'extension_dependency_edge backfill: malformed dependency edge on installed_extension % (declared index %) — repair the row jsonb before upgrading', bad.dependent_id, bad.declared_index;
    END IF;
    INSERT INTO "${q}"."extension_dependency_edge"
      (id, dependent_install_id, declared_package_name, declared_kind, edge_type,
       requirement, version_constraint, declared_index, resolved_install_id, resolution_reason)
    SELECT
      'iede_' || md5(ie.id || ':' || (d.ord - 1)::text),
      ie.id,
      d.elem->>'packageName',
      d.elem->>'kind',
      d.elem->>'edgeType',
      d.elem->>'requirement',
      d.elem->'versionConstraint',
      (d.ord - 1)::int,
      r.id,
      CASE WHEN r.id IS NULL THEN NULL
           WHEN r.organization_id IS NOT NULL THEN 'backfill:org'
           ELSE 'backfill:platform' END
    FROM "${q}"."installed_extension" ie
    CROSS JOIN LATERAL jsonb_array_elements(ie.dependencies) WITH ORDINALITY AS d(elem, ord)
    LEFT JOIN LATERAL (
      SELECT t.id, t.organization_id
      FROM "${q}"."installed_extension" t
      WHERE t.package_name = d.elem->>'packageName'
        AND t.status IN ('active','locked')
        AND (t.organization_id IS NULL OR t.organization_id = ie.organization_id)
      ORDER BY (t.organization_id IS NOT NULL) DESC, t.is_default DESC, t.id
      LIMIT 1
    ) r ON TRUE;
    ALTER TABLE "${q}"."installed_extension" DROP COLUMN dependencies;
  END IF;
END $$;` },
  ];
}
