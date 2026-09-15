// core__0097 — `artifact_review_audit.renderer_kind` admits `first-party`
// (cinatra#2931, epic #2926 W4).
//
// The operator-upgrade twin of the fresh-install bootstrap leaf
// `artifactReviewFormProvenanceSchemaQueries`
// (src/lib/artifacts/artifact-review-gate-schema.ts, spread into
// `buildCreateStoreSchemaQueries` in the SAME PR).
//
// WHY. W4 restored the rung the review card was missing: the host's own renderer
// for a declared text form (markdown, escaped plain text), which the artifact
// detail page had always consumed and the card had not. A markdown draft that
// used to reach the reviewer as "cannot render" with a Preview and a Download
// link now reaches them as the draft.
//
// A target the host rendered that way is RECORDED as rendered. The decision core
// re-resolves the mount at submit time and maps it to a renderer provenance,
// which `commitReviewDecision` writes into `artifact_review_audit.renderer_kind`
// inside the SAME transaction as the gate CAS. The form rung maps to
// `first-party`, deliberately not to `floor`: the floor gate counts floor rows,
// and a draft the reviewer read in full is not a review that fell through.
//
// THE DEFECT THIS CLOSES. `renderer_kind` carries a CHECK, created by
// core__0072, that admitted exactly `build-map`, `runtime`, `floor`. A value
// outside it does not degrade the audit row — the INSERT raises, and because the
// audit write happens after the CAS inside one transaction, the WHOLE decision
// rolls back (the same rollback the store's integration suite proves with a
// deliberately illegal kind). Without this migration a markdown draft would
// render perfectly under review on an upgraded instance and then be impossible
// to approve, reject or comment on: the gate would stay pending and the run
// would stay parked, with no reading anywhere saying why.
//
// THE SHAPE. Idempotent DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT — postgres
// names a column CHECK `<table>_<column>_check` deterministically, so this is a
// no-op on a schema the bootstrap already created wide and a widen on every
// deployed one. It is the exact idiom core__0081 used to widen the two
// disposition CHECKs on these same tables.
//
// ADDITIVE by the convention's enumeration (migrations/README.md): it only
// WIDENS a CHECK. Every value the old constraint admitted is still admitted, so
// no committed audit row can become invalid, no row is rewritten, and the
// re-validation scan the ADD CONSTRAINT performs passes by construction.
//
// SEQ 0097 — strictly greater than the max shipped seq on origin/main
// (core__0096 agent-run-created-at-immutable). migrations/** is HIGH-RISK:
// owner approval required; the lane never merges.
//
// DOWN. Narrows the CHECK back to the core__0072 vocabulary. HONEST COST: an
// instance that has already recorded a decision on a text-rendered target
// carries `first-party` audit rows, and the narrowed constraint would refuse to
// validate against them, so the `--down` fails loudly on exactly the instances
// where the forward shape is load-bearing. That is the correct failure: silently
// deleting an audit row to make a revert succeed would destroy the record of a
// decision a person actually made.
//
// Unqualified names ride the runner's search_path (the app schema), matching
// every sibling module in this chain.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it, and a no-op on any database the bootstrap has already created wide. */
export const artifactReviewAuditFirstPartyKindDdlSql = `
  ALTER TABLE artifact_review_audit DROP CONSTRAINT IF EXISTS artifact_review_audit_renderer_kind_check;
  ALTER TABLE artifact_review_audit ADD CONSTRAINT artifact_review_audit_renderer_kind_check
    CHECK (renderer_kind IN ('build-map','runtime','first-party','floor'));
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(artifactReviewAuditFirstPartyKindDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // See DOWN above: this FAILS on an instance that has recorded a decision on a
  // text-rendered target, and that is the correct outcome.
  pgm.sql(`
    ALTER TABLE artifact_review_audit DROP CONSTRAINT IF EXISTS artifact_review_audit_renderer_kind_check;
    ALTER TABLE artifact_review_audit ADD CONSTRAINT artifact_review_audit_renderer_kind_check
      CHECK (renderer_kind IN ('build-map','runtime','floor'));
  `);
}
