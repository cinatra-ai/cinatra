// core__0067 — agent_run_test_sends ledger (#1625, DESIGN-V3 contract (4)).
//
// One brand-new table backing the run-scoped test-delivery send primitive's
// per-action idempotency + crash recovery:
//
//   `agent_run_test_sends` — one row per gate-submission send action, keyed
//     UNIQUE (run_id, submission_id) where submission_id is the trusted per-resume
//     WayFlow task id. A transport retry of the SAME resume reuses the row (never a
//     second send); a genuine second send is a NEW gate re-entry (new submission_id
//     ⇒ new row). `seq` is the monotonic-per-run ordinal parse_action reads for the
//     maxGateVisits halt guard. `selected_draft_ids` pins the phase-1 plan BEFORE
//     any outbound send so a crash between claim and settle reconciles against a
//     durable expected batch (never rerandomized).
//
// ADDITIVE (one brand-new empty table + two indexes; migrations/README.md
// "Additive") — no artifact is REQUIRED. Shipped anyway (the core__0058/0055
// precedent) so fresh-bootstrap and operator-upgrade paths stay aligned. The DDL
// MIRRORS the idempotent bootstrap leaf (buildCreateStoreSchemaQueries in
// src/lib/drizzle-store.ts, the agent_run_test_sends block spread in the SAME PR)
// — a no-op on a bootstrap-seeded schema, ledger-faked on a fresh install,
// executed by `db migrate` on an existing deployment. Unqualified names ride the
// runner's search_path (the app schema); metadata-only DDL on an empty table, no
// noTransaction().
//
// SEQ assigned at ROUTE-time reconcile vs a fresh origin/main: shipped max is
// core__0064 (restamp-upload-rows-uploader-owned); the two OPEN sibling lanes hold
// core__0065 (#1915 assistant-registry-foundation) and core__0065→0066 (#1935
// chat-threads-cutover, pending its own renumber). This migration therefore takes
// the next GENUINELY FREE seq core__0067 (rename-only renumber from the provisional
// 0063, which now precedes the shipped 0064 — the runner tolerates the 0063/0066
// gaps). migrations/** is HIGH-RISK (owner approval); the lane never merges.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const agentRunTestSendsDdlSql = `
  CREATE TABLE IF NOT EXISTS agent_run_test_sends (
    id                  text PRIMARY KEY,
    run_id              text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    submission_id       text NOT NULL,
    seq                 integer NOT NULL,
    status              text NOT NULL DEFAULT 'sending',
    recipient_email     text,
    selected_draft_ids  jsonb NOT NULL,
    result_json         jsonb,
    claimed_at          timestamptz NOT NULL DEFAULT now(),
    lease_expires_at    timestamptz NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_run_test_sends_run_id_submission_id_uniq
    ON agent_run_test_sends (run_id, submission_id);
  CREATE INDEX IF NOT EXISTS agent_run_test_sends_run_id_idx
    ON agent_run_test_sends (run_id);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(agentRunTestSendsDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: a fresh addition, so dropping it restores the exact pre-0067
  // shape on any lineage (indexes ride the table drop). HONEST COST: any in-flight
  // test-send ledger rows are lost — an operator-initiated `--down` accepts that
  // (the table carries no data on a fresh install and an interrupted test send is
  // re-runnable).
  pgm.sql(`DROP TABLE IF EXISTS agent_run_test_sends;`);
}
