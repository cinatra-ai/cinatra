// core__0044 — partial index on assistant_turns.run_id (cinatra#1216 S2, the
// /chat AG-UI cutover). The new assistant run-stream route
// (GET /api/assistants/runs/[runId]/stream) authorizes a resume/tail
// subscription by resolving run_id → turn → thread before applying the
// thread's access policy. run_id is populated ONLY on runtime-minted turn
// rows (one per AG-UI run); the P2b legacy-mirror rows carry run_id NULL by
// design and dominate the table — hence a PARTIAL index so mirror rows never
// enter it.
//
// WHY A MIGRATION. The index is additive — the bootstrap DDL
// (assistantThreadSchemaQueries, same PR) creates it via `CREATE INDEX IF NOT
// EXISTS`, so a fresh install is born at the target shape and ledger-fakes
// this chain. This module carries the SAME create onto the operator upgrade
// path, mirroring the core__0026 convention for these tables. Idempotent both
// ways; unqualified names resolve to the runner's search_path schema.
//
// down() drops the index (IF EXISTS) — a pure performance revert, no data
// loss.

const TURNS_RUN_ID_IDX = "assistant_turns_run_id_idx";

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS ${TURNS_RUN_ID_IDX} ON assistant_turns (run_id) WHERE run_id IS NOT NULL`,
  );
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DROP INDEX IF EXISTS ${TURNS_RUN_ID_IDX}`);
}
