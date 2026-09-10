// core__0105 — the picture's provenance on its ledger row (cinatra#3032, epic
// #3023 W8; plan (C) item 0.28: "the prompt, the provider and the model on the
// ledger row of that write"). The operator-upgrade twin of the fresh-install
// bootstrap DDL (`artifactClaimSchemaQueries` in src/lib/artifact-claim-schema.ts,
// extended in the SAME change) — the two halves ship together, the core__0103 /
// core__0104 precedent.
//
// THREE additive nullable columns on `artifact_materializations`:
//
//   - `image_prompt`   (text) — the prompt THIS revision was generated from.
//   - `image_provider` (text) — the deployment's configured image provider that
//                               served the call.
//   - `image_model`    (text) — the model the adapter addressed, which need not
//                               be the one the caller named.
//
// WHY: every other artifact write records what it wrote in the bytes it wrote.
// A picture does not — the bytes say nothing about what was asked for, and a
// regeneration appends a revision to the SAME artifact from a different prompt.
// Without these columns "which prompt, which provider and which model made this
// revision" has no answer anywhere.
//
// NO CHECK is rewritten and no row is touched: the columns are additive and
// nullable, and every existing row reads NULL on all three, which is exactly
// right — those rows were written by paths that make no picture. The core-store
// schema migration gate classifies a purely additive nullable column set as
// NON-destructive, so this fragment carries no destructive flag.
//
// SEQ 0105 — strictly greater than the max shipped seq on this branch
// (core__0104).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const imageGenerationLedgerDdlSql = `
  ALTER TABLE artifact_materializations ADD COLUMN IF NOT EXISTS image_prompt text;
  ALTER TABLE artifact_materializations ADD COLUMN IF NOT EXISTS image_provider text;
  ALTER TABLE artifact_materializations ADD COLUMN IF NOT EXISTS image_model text;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(imageGenerationLedgerDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    ALTER TABLE artifact_materializations DROP COLUMN IF EXISTS image_prompt;
    ALTER TABLE artifact_materializations DROP COLUMN IF EXISTS image_provider;
    ALTER TABLE artifact_materializations DROP COLUMN IF EXISTS image_model;
  `);
}
