// core__0099 — `artifact_produced_outbox.emitter` admits `object_snapshot_mint`
// (cinatra#3028, epic #3023, lifecycle-c W4 — enabler 0.13, the object-backed
// contract).
//
// The operator-upgrade twin of the fresh-install bootstrap leaf
// `artifactReviewGateSchemaQueries` (src/lib/artifacts/artifact-review-gate-schema.ts,
// widened in the SAME PR).
//
// WHY. `PLAN: Agents Lifecycle (C)` §3 fixes the object-backed contract: "An
// object-backed type declares its object-data schema. Its display receives a
// discriminated projection — the live object data, or a minted snapshot
// revision — and says which of the two it is showing. Minting the snapshot is
// what makes a row reviewable, and the produced event is emitted AT THE MINT,
// never at the raw row write." The road matrix in that section keeps the raw
// typed-object writes as its one "no" row for exactly that reason: an
// object-backed row has no representation to name until a snapshot exists.
//
// The mint is therefore a NEW produced-event choke point, and the produced-event
// contract (src/lib/lifecycle/lifecycle-produced-event.ts) enumerates its
// emitters: "A produced event may ONLY originate from one of these local write
// choke points — the closed set is the audit surface the S1 wiring and the
// reconciliation sweeper reason over. A row carrying any other emitter is an
// invariant violation." The mint is not the CMS staged write
// (`object_cms_snapshot_capture`) and must not borrow its name: two roads, two
// emitters, or "which road produced this" becomes unanswerable.
//
// THE DEFECT THIS CLOSES. The `emitter` column carries an inline CHECK created
// with the table, admitting exactly the three emitters that existed then. On an
// upgraded instance the mint's INSERT would raise inside the capture's own
// transaction, so the WHOLE snapshot capture would roll back: an object-backed
// row would be un-snapshottable — and therefore unreviewable — with the failure
// surfacing as a constraint violation nowhere near the contract that caused it.
//
// THE SHAPE. Idempotent DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT — postgres
// names a column CHECK `<table>_<column>_check` deterministically — so this is a
// no-op on a schema the bootstrap already created wide and a widen on every
// deployed one. The exact idiom core__0097 used on `artifact_review_audit`.
//
// ADDITIVE in effect: every value the old constraint admitted is still admitted,
// so no committed outbox row can become invalid, no row is rewritten, and the
// re-validation scan the ADD CONSTRAINT performs passes by construction.
//
// SEQ 0099 — 0098 is claimed on another branch of this epic; 0099 is the next
// free sequence at authoring time. migrations/** is HIGH-RISK: owner approval
// required; the lane never merges.
//
// DOWN. Narrows the CHECK back to the three-emitter vocabulary. HONEST COST: an
// instance that has already minted a snapshot under the object-backed contract
// carries `object_snapshot_mint` rows, and the narrowed constraint refuses to
// validate against them, so `--down` fails loudly on exactly the instances where
// the forward shape is load-bearing. That is the correct failure: deleting an
// outbox row to make a revert succeed would drop a review the product opened.
//
// Unqualified names ride the runner's search_path (the app schema), matching
// every sibling module in this chain.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it, and a no-op on any database the bootstrap has already created wide. */
export const artifactProducedOutboxObjectSnapshotMintEmitterDdlSql = `
  ALTER TABLE artifact_produced_outbox DROP CONSTRAINT IF EXISTS artifact_produced_outbox_emitter_check;
  ALTER TABLE artifact_produced_outbox ADD CONSTRAINT artifact_produced_outbox_emitter_check
    CHECK (emitter IN ('createSemanticArtifact','dashboard_twin_writer','object_cms_snapshot_capture','object_snapshot_mint'));
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(artifactProducedOutboxObjectSnapshotMintEmitterDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // See DOWN above: this FAILS on an instance that has already minted an
  // object-backed snapshot, and that is the correct outcome.
  pgm.sql(`
    ALTER TABLE artifact_produced_outbox DROP CONSTRAINT IF EXISTS artifact_produced_outbox_emitter_check;
    ALTER TABLE artifact_produced_outbox ADD CONSTRAINT artifact_produced_outbox_emitter_check
      CHECK (emitter IN ('createSemanticArtifact','dashboard_twin_writer','object_cms_snapshot_capture'));
  `);
}
