// core__0101 — the EXECUTED artifact-binding declaration on `agent_templates`
// (cinatra#3208). The operator-upgrade twin of the fresh-install bootstrap DDL
// (`buildCreateStoreSchemaQueries` in src/lib/drizzle-store.ts, extended in the
// SAME PR) — the two halves ship together, exactly like core__0091.
//
// ONE additive nullable column on `agent_templates`:
//
//   - `artifact_bindings` (text, JSON-as-text, NULLABLE — three-valued ON
//     PURPOSE, mirroring `has_artifact_bindings`): the normalized
//     `outputs[].cinatra.artifact` bindings the compile that produced THIS
//     template version actually found, together with the typed
//     `cinatra.produces` refs they were validated against (grammar,
//     serializer and fail-closed parser: packages/agents/src/artifact-binding.ts).
//     null = unknown — a row compiled before this column existed, or a compile
//     that could not see its sibling package.json, where binding/produces
//     parity was never established.
//
// WHY: run completion materialized a run's artifacts by re-reading the PACKAGE
// REGISTRY for the run's (package_name, package_version) pair, while execution
// was bound to the immutable template-version snapshot on this row. Two
// authorities, nothing binding them together: when the registry's copy of a
// version diverged from the copy the template was compiled from, the run was
// materialized against a declaration it never executed and failed AFTER all of
// the model work was done. The run-completion materializer
// (src/lib/artifacts/run-artifact-materializer.ts) now reads THIS column, under
// the same version-pin guard `has_artifact_bindings` already uses, and does not
// call the registry at all when it resolves.
//
// Written ONLY together with `package_version`, in one statement, by every
// install/recompile writer — the version-pin guard is worthless if the two land
// in separate writes.
//
// No backfill, no rewrite, no constraint change on existing data: every
// existing row reads NULL ("unknown"), which is the SAME registry-reading,
// fail-closed behavior every row had before this column existed (this repo's
// standing pre-release no-backward-compat convention; the choice to skip a
// backfill is recorded here and in the PR body). The schema-migration gate
// classifies this NON-destructive.
//
// SEQ 0101 — strictly greater than the max shipped seq on origin/main
// (core__0100). A concurrent lane may land the next seq first, in which case a
// rename-only renumber is normal (FLAGGED for the coordinator's train).
// migrations/** is HIGH-RISK: owner approval required; the lane never merges.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const agentTemplateArtifactBindingsDdlSql = `
  ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS artifact_bindings text;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(agentTemplateArtifactBindingsDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the added column. Loses the persisted executed
  // declaration, so run completion reverts to the pre-#3208 posture — it
  // re-reads the package registry for the run's pinned version and can once
  // again materialize against a declaration the run did not execute.
  pgm.sql(`
    ALTER TABLE agent_templates DROP COLUMN IF EXISTS artifact_bindings;
  `);
}
