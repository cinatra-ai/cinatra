// core__0117 — the verification record names the gate it reopened (cinatra#4312).
// The operator-upgrade twin of the fresh-install bootstrap ALTER in
// `lifecycleInterceptionsSchemaQueries` (src/lib/artifacts/artifact-review-gate-schema.ts),
// added in the SAME pull request.
//
// WHY. A changes-requested note on a verification-reopen gate joins the repair
// lineage only when verification opened that gate. The unique (run, task) slot
// proves only that the gate occupies the slot; any same-organization caller can
// emit into it first. `reopened_gate_id` is written in the transaction that
// inserts the gate, only by the verification that inserted it.
//
// BACKFILL, ONCE. On a database upgraded from before this column, a reopen gate
// verification opened has no name yet, and without one its repair lineage reads
// malformed. The old writer inserted the record first and the gate after it, so
// this names the gate in the record's slot when it is on the run and in the
// organization of the record's gate and was created at or after the record. A
// gate a caller emitted into the slot before the upgrade and after the record
// cannot be told apart from those rows and is named as well. A gate created before
// the record is not named, and its lineage refuses it. This runs once, in this
// migration; the bootstrap never repeats it, because after the upgrade only the
// writer names a gate.
//
// DOWN drops the column; the names are not restorable, and the code that reads
// them goes with the same revert.
//
// SEQ 0117 — 0113 is the highest on main; 0114 to 0116 are claimed by open changes.
//
// Unqualified names ride the runner's search_path (the app schema).

/** Idempotent DDL mirroring the bootstrap ALTER — safe to run after it. */
export const verificationReopenedGateDdlSql = `
  ALTER TABLE artifact_verification_records
    ADD COLUMN IF NOT EXISTS reopened_gate_id text
    REFERENCES artifact_review_gates (id) ON DELETE SET NULL;
`;

/** The one-time naming of the reopen gates written before this column. */
export const verificationReopenedGateBackfillSql = `
  UPDATE artifact_verification_records AS r
     SET reopened_gate_id = reopen.id
    FROM artifact_review_gates AS verified, artifact_review_gates AS reopen
   WHERE r.reopened_gate_id IS NULL
     AND verified.id = r.gate_id
     AND reopen.review_task_id = 'lifecycle-review:verify:' || r.id
     AND reopen.run_id = verified.run_id
     AND reopen.org_id = verified.org_id
     AND reopen.created_at >= r.created_at;
`;

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function up(pgm) {
  pgm.sql(verificationReopenedGateDdlSql);
  pgm.sql(verificationReopenedGateBackfillSql);
}

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function down(pgm) {
  pgm.sql(`ALTER TABLE artifact_verification_records DROP COLUMN IF EXISTS reopened_gate_id;`);
}
