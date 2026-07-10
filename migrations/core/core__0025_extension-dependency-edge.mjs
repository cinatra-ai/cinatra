// core__0025 — EXTENSION DEPENDENCY EDGES move off the row jsonb
//
// SEQ COORDINATION (open-PR claim ledger at renumber time): core__0023 is
// claimed by cinatra-ai/cinatra#1304 (assistant threads/turns) and core__0024
// by cinatra-ai/cinatra#1329 (project dispatch ledger/lease); this migration
// was renumbered 0024 → 0025 to defuse the double-claim with #1329. The
// runner tolerates seq gaps until those PRs land.
//
// (cinatra-ai/cinatra#1040 S2, the edge-storage half). Dependency edges leave
// `installed_extension.dependencies` (jsonb ExtensionDependency[]) for a
// first-class `extension_dependency_edge` table:
//
//   • the DECLARED half — declared_package_name / declared_kind / edge_type /
//     requirement / version_constraint (the VersionConstraint union as jsonb,
//     lossless round-trip) / declared_index (manifest array position; unique
//     per dependent — positional, NOT a semantic dedupe: duplicate declared
//     packages stay representable, the manifest reader owns dedupe);
//   • the RESOLVED half — resolved_install_id (WHICH installed row satisfied
//     the edge at write time; FK ON DELETE SET NULL) + resolution_reason
//     (free-form provenance, diagnostics only).
//
// The closure gates (boot/archive/restore/forward) VALIDATE resolved edges —
// a pinned row is checked for liveness + version-constraint satisfaction — and
// fall back to the scoped name-lookup for unresolved edges, preserving the
// pre-S2 "dependency installed later heals the closure" semantics.
//
// BACKFILL RESOLUTION RULE (the single rule, mirrored by the canonical
// store's write-time resolver and the closure engine's fallback): the
// DECLARING row's own-org live (active|locked) row first, then the platform
// row — a platform-scoped dependent binds only platform rows — preferring the
// DEFAULT version (is_default DESC, from core__0022), deterministic id
// tie-break. A missing target backfills UNRESOLVED (NULL id + NULL reason).
// NOTE (intentional semantic correction, stated on the S2 PR): resolution is
// per-DECLARING-row scope; the old transitive walk reused the traversal
// ROOT's scope, which could satisfy a platform intermediate's edge from an
// org row — cross-scope bleed the update gate already refused.
//
// PREFLIGHT: malformed legacy edges FAIL the migration loudly (naming the
// dependent row + declared index) BEFORE any destructive work — silently
// skipping an edge and then dropping the source column would silently weaken
// the closure gates. The migration runs in one transaction (node-pg-migrate
// default), so a preflight failure leaves the schema untouched.
//
// WHY A MIGRATION (transformational half). The table alone is additive — the
// bootstrap DDL (dependencyEdgeSchemaQueries in src/lib/extension-grant-schema.ts,
// spread into buildCreateStoreSchemaQueries, same PR) creates it IF NOT EXISTS
// and a fresh install is born at the target shape (no jsonb column at all),
// ledger-faking this chain. But the backfill + DROP COLUMN over a table that
// already holds rows in a DEPLOYED database is transformational — it needs
// this module on the operator upgrade path (`cinatra db migrate` / the boot
// runner, which always executes; see migrations/README.md).
//
// DEPLOY BOUNDARY (coordinated, NON-rolling — as core__0022/core__0005). A
// pre-0025 app process reads/writes the `dependencies` column by name; after
// the drop those statements FAIL CLOSED (undefined column), never a silent
// wrong read. Apply with old writers drained (the standard release boundary).
//
// IDEMPOTENT / LINEAGE-TOLERANT. CREATE TABLE / indexes are IF NOT EXISTS;
// the preflight + backfill + drop live in ONE DO block guarded on the legacy
// column's existence, so a re-run — or a run after the bootstrap leaf already
// converged the schema — is a no-op (a second up() never references the
// dropped column). Backfill edge ids are DETERMINISTIC
// ('iede_' || md5(dependent_id:declared_index)) so any accidental re-entry
// collides on the primary key instead of duplicating rows. Unqualified names
// ride the runner's search_path (the app schema).
//
// down() is a true reverse: re-add the jsonb column, re-serialize each
// dependent's edges (declared order; the optional kind key only when
// present), drop the table. Resolution provenance (resolved_install_id /
// resolution_reason) is lost by design — it is derivable-at-write data the
// pre-S2 schema never carried.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`CREATE TABLE IF NOT EXISTS extension_dependency_edge (
    id text PRIMARY KEY,
    dependent_install_id text NOT NULL REFERENCES installed_extension(id) ON DELETE CASCADE,
    declared_package_name text NOT NULL,
    declared_kind text,
    edge_type text NOT NULL CHECK (edge_type IN ('runtime','install-time','peer')),
    requirement text NOT NULL CHECK (requirement IN ('required','optional')),
    version_constraint jsonb NOT NULL,
    declared_index integer NOT NULL DEFAULT 0,
    resolved_install_id text REFERENCES installed_extension(id) ON DELETE SET NULL,
    resolution_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS extension_dependency_edge_dependent_pos_uniq
    ON extension_dependency_edge (dependent_install_id, declared_index);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS extension_dependency_edge_resolved_idx
    ON extension_dependency_edge (resolved_install_id);`);

  pgm.sql(`DO $$
DECLARE bad record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'installed_extension'
      AND column_name = 'dependencies'
  ) THEN
    SELECT ie.id AS dependent_id, (d.ord - 1)::int AS declared_index INTO bad
    FROM installed_extension ie
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
    INSERT INTO extension_dependency_edge
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
    FROM installed_extension ie
    CROSS JOIN LATERAL jsonb_array_elements(ie.dependencies) WITH ORDINALITY AS d(elem, ord)
    LEFT JOIN LATERAL (
      SELECT t.id, t.organization_id
      FROM installed_extension t
      WHERE t.package_name = d.elem->>'packageName'
        AND t.status IN ('active','locked')
        AND (t.organization_id IS NULL OR t.organization_id = ie.organization_id)
      ORDER BY (t.organization_id IS NOT NULL) DESC, t.is_default DESC, t.id
      LIMIT 1
    ) r ON TRUE;
    ALTER TABLE installed_extension DROP COLUMN dependencies;
  END IF;
END $$;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(
    `ALTER TABLE installed_extension ADD COLUMN IF NOT EXISTS dependencies jsonb NOT NULL DEFAULT '[]'::jsonb;`,
  );
  // Re-serialize each dependent's edges back into the row jsonb, declared
  // order, with the OPTIONAL kind key present only when the edge carried one
  // (jsonb_build_object would emit "kind": null otherwise, which the shape
  // validator refuses).
  pgm.sql(`UPDATE installed_extension ie
    SET dependencies = COALESCE((
      SELECT jsonb_agg(
        (jsonb_build_object(
          'packageName', e.declared_package_name,
          'edgeType', e.edge_type,
          'versionConstraint', e.version_constraint,
          'requirement', e.requirement
        ) || CASE WHEN e.declared_kind IS NULL THEN '{}'::jsonb
                  ELSE jsonb_build_object('kind', e.declared_kind) END)
        ORDER BY e.declared_index, e.id)
      FROM extension_dependency_edge e
      WHERE e.dependent_install_id = ie.id
    ), '[]'::jsonb);`);
  pgm.sql(`DROP TABLE IF EXISTS extension_dependency_edge;`);
}
