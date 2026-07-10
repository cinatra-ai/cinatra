// core__0019 — the interaction axis on agent_templates (cinatra-ai/cinatra#1037
// P1, the schema half). Adds `agent_kind` (`assistant|executor`, default `executor`)
// and the typed `assistant_config` sidecar (JSON-as-text), plus the two
// authoritative write-time invariants:
//
//   • agent_templates_agent_kind_check         — agent_kind IN ('assistant','executor')
//   • agent_templates_agent_kind_config_check  — an `assistant` row MUST carry a
//                                                 config; an `executor` row MUST NOT.
//
// `agent_kind` is ORTHOGONAL to `type` (leaf|proxy|orchestrator, the
// execution-topology axis) — this migration deliberately does NOT overload
// `type`, and introduces NO "project" kind.
//
// WHY A MIGRATION (transformational half). The two columns alone are additive —
// the bootstrap DDL (buildCreateStoreSchemaQueries, same PR) adds them via
// `ADD COLUMN IF NOT EXISTS`, so a fresh install is born at the target shape
// and ledger-fakes this chain. But adding a CHECK constraint over a table that
// already holds rows in a DEPLOYED database is a transformational change the
// bootstrap `CREATE TABLE IF NOT EXISTS` cannot express — it needs this module
// on the operator upgrade path. Every existing row defaults to
// `agent_kind='executor'` with `assistant_config=NULL`, which satisfies the
// pairing CHECK, so the constraint validates cleanly with no backfill (there
// are no pre-existing `assistant` rows — the column is brand new).
//
// IDEMPOTENT / LINEAGE-TOLERANT. Columns are `IF NOT EXISTS`; each constraint
// is added only when absent (looked up in pg_constraint against the runner's
// search_path via current_schema()); the index is `IF NOT EXISTS`. Re-running
// against an already-migrated schema — or against the bootstrap-produced fresh
// shape — is a no-op. Unqualified table names resolve to the app schema the
// runner sets on search_path (what keeps worktree/branch schemas working).
//
// down() is a true reverse: drop the constraints, the index, then the columns.
// A revert loses the interaction-axis data (kind + config) by design — this is
// a structural addition, not a rename.

const KIND_CHECK = "agent_templates_agent_kind_check";
const CONFIG_CHECK = "agent_templates_agent_kind_config_check";
const KIND_INDEX = "agent_templates_agent_kind_idx";

/**
 * Add a CHECK constraint only when it is absent, resolved against the runner's
 * search_path (`current_schema()`). Postgres has no `ADD CONSTRAINT IF NOT
 * EXISTS`; this mirrors the bootstrap's `addConstraintIfAbsentSql`. All names
 * are compile-time constants of this module — nothing interpolates runtime
 * input.
 */
function addCheckIfAbsentSql(constraintName, checkExpr) {
  return `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'agent_templates'
      AND c.conname = '${constraintName}'
  ) THEN
    ALTER TABLE agent_templates
      ADD CONSTRAINT ${constraintName} CHECK (${checkExpr});
  END IF;
END $$;`;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // 1. Columns (additive; guarded so the operator path is safe even if the
  //    candidate bootstrap DDL has not run first).
  pgm.sql(
    `ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS agent_kind text NOT NULL DEFAULT 'executor';`,
  );
  pgm.sql(
    `ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS assistant_config text;`,
  );

  // 2. Invariants (the transformational half — a CHECK over already-populated
  //    rows). All existing rows are executor/NULL and pass cleanly.
  pgm.sql(addCheckIfAbsentSql(KIND_CHECK, `agent_kind IN ('assistant', 'executor')`));
  pgm.sql(
    addCheckIfAbsentSql(
      CONFIG_CHECK,
      `(agent_kind = 'assistant' AND assistant_config IS NOT NULL)
       OR (agent_kind = 'executor' AND assistant_config IS NULL)`,
    ),
  );

  // 3. Read index for kind-filtered lists (mentionable-assistant enumeration).
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS ${KIND_INDEX} ON agent_templates (agent_kind);`,
  );
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`ALTER TABLE agent_templates DROP CONSTRAINT IF EXISTS ${CONFIG_CHECK};`);
  pgm.sql(`ALTER TABLE agent_templates DROP CONSTRAINT IF EXISTS ${KIND_CHECK};`);
  pgm.sql(`DROP INDEX IF EXISTS ${KIND_INDEX};`);
  pgm.sql(`ALTER TABLE agent_templates DROP COLUMN IF EXISTS assistant_config;`);
  pgm.sql(`ALTER TABLE agent_templates DROP COLUMN IF EXISTS agent_kind;`);
}
