// core__0125 — the verification record names its reopen gate (cinatra#4312).
// The operator-upgrade twin of the fresh-install bootstrap ALTER in
// `lifecycleInterceptionsSchemaQueries` (src/lib/artifacts/artifact-review-gate-schema.ts),
// added in the SAME pull request.
//
// WHY. A changes-requested note on a verification-reopen gate joins the repair
// lineage only when the record names that gate. The unique (run, task) slot
// proves only that the gate occupies the slot; any same-organization caller can
// emit into it first. The verification writes `reopened_gate_id` in the transaction
// that inserts the gate, and only for a gate it inserted. One more statement writes
// the name: the backfill below, which this migration runs once and the review
// orchestration sweep repeats (OLD WRITERS). It reads only the repair rows, so it can
// also name a gate that a caller put in the slot, once such a row rests on that gate.
//
// BACKFILL, FAIL-CLOSED. On a database upgraded from before this column, a
// lineage that already went on through a reopen gate has no name to read, and it
// would read as malformed. So this names a gate only when it already carries a
// repair row at attempt 2 or later, in the record's slot, on the run and in the
// organization of the record's gate, created at or after the record (the old writer
// wrote the record first). That joins nothing new: the old code had already joined
// such a gate to the lineage, which includes a caller's gate it let in.
//
// THE COST. A reopen gate the old writer opened that is pending at the upgrade with
// no note on it carries no repair row, so it stays unnamed, as does a caller's gate
// with no row: the data cannot tell them apart. A re-drive of its verification answers
// `reopen-conflict`, and a changes-requested note the new code receives on it is
// refused (`lineage-unbound`). Continue still resolves such a gate.
//
// OLD WRITERS. The deploy runs this migration while the old application still serves,
// so the old code can write a note on an unnamed gate after this statement ran. Its
// lineage reads as malformed until the review orchestration sweep runs the same
// statement (`verificationReopenNamesSql`, pinned equal by a test). The new code writes
// no repair row on an unnamed gate, so such a row is the old code's or was written by
// hand. The sweep names the gate either way. On a lineage that started on a declared
// review leg, the lineage reader never takes a reopen gate as the next attempt (the
// declared-lineage check), so a name written there leaves that lineage malformed.
//
// CARRIER. The sweep's naming, in its own transaction, also carries the latest decision
// of a declared review whose lineage it makes read closed (lifecycle-repair-store
// `carryDeclaredReviewDecision`). This migration's run of the statement carries none:
// it runs before the new application serves, so no lineage the new code wrote exists
// yet, and the old code wrote no lineage on a declared review's gate (its review
// surface refused changes requested on any flow-authored gate).
//
// The bootstrap never repeats this statement.
//
// DOWN drops the column; the names are not restorable, and the code that reads
// them goes with the same revert.
//
// SEQ 0125 — this change took 0125 when 0122 was the highest on main and other changes
// claimed 0115, 0116, 0120, 0123 and 0124. If a migration numbered above 0125 reaches main
// before this one, this change takes the next free number before it merges.
//
// Unqualified names ride the runner's search_path (the app schema).

/** Idempotent DDL mirroring the bootstrap ALTER — safe to run after it. */
export const verificationReopenedGateDdlSql = `
  ALTER TABLE artifact_verification_records
    ADD COLUMN IF NOT EXISTS reopened_gate_id text
    REFERENCES artifact_review_gates (id) ON DELETE SET NULL;
`;

/** The naming of the reopen gates written before this column: this migration runs it once,
 * and the review orchestration sweep repeats the same statement (a test pins the two equal). */
export const verificationReopenedGateBackfillSql = `
  UPDATE artifact_verification_records AS r
     SET reopened_gate_id = reopen.id
    FROM artifact_review_gates AS verified, artifact_review_gates AS reopen
   WHERE r.reopened_gate_id IS NULL
     AND verified.id = r.gate_id
     AND reopen.review_task_id = 'lifecycle-review:verify:' || r.id
     AND reopen.run_id = verified.run_id
     AND reopen.org_id = verified.org_id
     AND reopen.created_at >= r.created_at
     AND EXISTS (
       SELECT 1 FROM lifecycle_repair AS attempt
        WHERE attempt.gate_id = reopen.id AND attempt.attempt >= 2
     );
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
