// core__0086 — the declared dependency-edge ROLE column (cinatra#2090 S3, epic
// #2086). The operator-upgrade twin of the fresh-install bootstrap DDL
// (`dependencyEdgeSchemaQueries` in src/lib/extension-grant-schema.ts, extended
// in the SAME PR) — the two halves ship together, exactly like core__0085.
//
// ONE additive nullable column on `extension_dependency_edge`:
//
//   - `declared_role` (text, NULLABLE): which host surface a `kind:"skill"`
//     edge feeds. The S3 separation rule turns a co-located skill bundle into a
//     declared dependency, and an artifact extension declares MORE THAN ONE
//     skill edge (the classifier's rules and the chat's authoring
//     methodology), so the edge has to say which surface it is for. The
//     canonical `ExtensionDependency.role` already carries it from the
//     manifest reader; without this column a write/read round-trip would
//     silently turn a roled edge back into a role-less one.
//
// Values are constrained to the declared vocabulary ('matcher' | 'authoring')
// so a typo cannot reach a row; NULL means "no role", which is exactly what
// every edge persisted before this vocabulary existed means, and is also the
// plain injectable delivery an agent→skill edge uses.
//
// No backfill, no rewrite, no constraint change on existing data: every
// existing row reads NULL, which is its unchanged meaning. The
// schema-migration gate classifies this NON-destructive.
//
// SEQ 0086 — strictly greater than the max shipped seq on origin/main
// (core__0085). A concurrent lane may land the next seq first, in which case a
// rename-only renumber is normal (FLAGGED for the coordinator's train).
// migrations/** is HIGH-RISK: owner approval required; the lane never merges.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const dependencyEdgeDeclaredRoleDdlSql = `
  ALTER TABLE extension_dependency_edge ADD COLUMN IF NOT EXISTS declared_role text;
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'extension_dependency_edge_declared_role_chk'
        AND conrelid = 'extension_dependency_edge'::regclass
    ) THEN
      ALTER TABLE extension_dependency_edge
        ADD CONSTRAINT extension_dependency_edge_declared_role_chk
        CHECK (declared_role IS NULL OR declared_role IN ('matcher','authoring'));
    END IF;
  END $$;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(dependencyEdgeDeclaredRoleDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the constraint and the column. Loses the declared role on
  // every persisted edge, which reverts each one to "no role" — the meaning it
  // carried before this migration. The manifests themselves are untouched, so
  // a re-install re-derives the roles.
  pgm.sql(`
    ALTER TABLE extension_dependency_edge
      DROP CONSTRAINT IF EXISTS extension_dependency_edge_declared_role_chk;
    ALTER TABLE extension_dependency_edge DROP COLUMN IF EXISTS declared_role;
  `);
}
