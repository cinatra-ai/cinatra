// core__0085 — per-agent execution config storage (exec-plane S3 slice B,
// cinatra#1708; epic #1705). The operator-upgrade twin of the fresh-install
// bootstrap DDL (`buildCreateStoreSchemaQueries` in src/lib/drizzle-store.ts,
// extended in the SAME PR) — the two halves ship together, exactly like
// core__0054 / core__0079.
//
// Two ADDITIVE nullable columns on `agent_templates`, the PROJECT-agent
// authoring surface for the L1 declared environment:
//
//   - `execution_environment` (text, JSON-as-text — the compiled_plan /
//     gated_steps / lifecycle_config convention on this very table): the RAW
//     declared `ExecutionEnvironmentSpec` for a project agent. It is read
//     through the SAME fail-closed parser packaged-agent manifests go through
//     (`parseExecutionEnvironment`, @cinatra-ai/sdk-extensions), so both
//     authoring surfaces resolve to ONE internal type and two same-recipe
//     agents share one L1 cache entry regardless of where the recipe was
//     authored. `AgentTemplateRecord.executionEnvironment` has been
//     typed-optional since PR #1754 and the immutable version snapshot already
//     captures it (`buildSnapshotFromTemplate`) — this column is the storage
//     that activates both.
//   - `execution_enabled` (boolean, NULLABLE — three-valued ON PURPOSE):
//     NULL = inherit the instance/org posture (epic D4's default-on
//     availability), true = explicitly on for this agent, false = explicitly
//     opted out. A two-valued column with a default would silently RE-DECIDE
//     the posture for every existing row; NULL keeps every pre-slice-B row
//     byte-identical in meaning.
//
// No backfill, no rewrite, no constraint change: every existing row reads NULL
// on both columns, which is exactly "no declared environment / inherit" — the
// pre-slice-B behaviour. The schema-migration gate classifies this
// NON-destructive.
//
// SEQ 0085 — strictly greater than the max shipped seq on origin/main
// (core__0084). A concurrent lane may land the next seq first, in which case a
// rename-only renumber is normal (FLAGGED for the coordinator's train).
// migrations/** is HIGH-RISK: owner approval required; the lane never merges.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const agentTemplateExecutionConfigDdlSql = `
  ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS execution_environment text;
  ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS execution_enabled boolean;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(agentTemplateExecutionConfigDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the two added columns. Loses the per-agent declared
  // environment + opt-out (empty before slice B; a template that declared one
  // simply reverts to "no declared environment / inherit", which is the
  // pre-slice-B meaning). Immutable version snapshots are untouched — they
  // carry their own captured copy.
  pgm.sql(`
    ALTER TABLE agent_templates DROP COLUMN IF EXISTS execution_enabled;
    ALTER TABLE agent_templates DROP COLUMN IF EXISTS execution_environment;
  `);
}
