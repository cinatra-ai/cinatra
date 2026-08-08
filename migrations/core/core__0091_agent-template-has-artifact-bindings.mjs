// core__0091 — the locally-persisted binding-presence authority on
// `agent_templates` (cinatra#2498). The operator-upgrade twin of the
// fresh-install bootstrap DDL (`buildCreateStoreSchemaQueries` in
// src/lib/drizzle-store.ts, extended in the SAME PR) — the two halves ship
// together, exactly like core__0085 / core__0086 / core__0089.
//
// ONE additive nullable column on `agent_templates`:
//
//   - `has_artifact_bindings` (boolean, NULLABLE — three-valued ON PURPOSE):
//     true = the OAS document this template was compiled from (at install
//     via buildAgentTemplateInstallSeed, or at recompile via
//     agent_source_compile) declares at least one
//     `outputs[].cinatra.artifact` binding; false = it declares none; null =
//     unknown (a row compiled before this column existed). The run-completion
//     materializer (src/lib/artifacts/run-artifact-materializer.ts) reads
//     this column FIRST and short-circuits BEFORE any registry read when it
//     is false — a registry outage can therefore never fail a binding-less
//     run's completion (cinatra#2496 disclosed this as narrower-scope
//     follow-up work; this migration is that follow-up). true and null both
//     fall through to the existing registry read + fail-closed posture,
//     because neither can be locally proven safe.
//
// No backfill, no rewrite, no constraint change on existing data: every
// existing row reads NULL, which means "unknown" — the SAME fail-closed
// behavior every row had before this column existed (this repo's standing
// pre-v0.2.0 no-backward-compat convention: the choice to skip a backfill,
// recorded here and in the PR body, per cinatra#2498 acceptance item 3). The
// schema-migration gate classifies this NON-destructive.
//
// SEQ 0091 — strictly greater than the max shipped seq on origin/main
// (core__0090). A concurrent lane may land the next seq first, in which case
// a rename-only renumber is normal (FLAGGED for the coordinator's train).
// migrations/** is HIGH-RISK: owner approval required; the lane never merges.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const agentTemplateHasArtifactBindingsDdlSql = `
  ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS has_artifact_bindings boolean;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(agentTemplateHasArtifactBindingsDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the added column. Loses the locally-persisted
  // binding-presence fact (a run's terminal completion reverts to the
  // pre-#2498 posture: every registry-read failure fails closed, regardless
  // of whether the package actually declares bindings).
  pgm.sql(`
    ALTER TABLE agent_templates DROP COLUMN IF EXISTS has_artifact_bindings;
  `);
}
