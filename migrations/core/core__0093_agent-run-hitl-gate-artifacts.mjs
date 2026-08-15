// core__0093 — durable human-approval GATE artifact store (cinatra#2748).
//
// ONE brand-new table, `agent_run_hitl_gates`, that gives a paused run's gate a
// store that survives a Redis eviction, expiry, or restart.
//
// THE DEFECT. A run parked on `pending_approval` carries ONE human-answerable
// artifact: the AG-UI INTERRUPT frame in the Redis Streams run event log. That
// log expires. When the key is gone the artifact is gone from every store, the
// HITL derivation falls back to a formless shell, and the run renders an
// unanswerable banner forever. This table is the durable fallback: Redis stays
// the hot path, the row answers when the frame is gone.
//
// SHAPE. One row per (run_id, review_task_id) — the PRIMARY KEY, and the same
// gate identity the park seam's read-back verification matches on, so a re-park
// of the same gate UPSERTS rather than duplicating. The row carries exactly what
// a surface needs to RENDER and ANSWER the gate: x_renderer, input_schema,
// gate_values, and field_name for the setup-loop gates that declare one.
// materialized_at is the write's own clock and the MONOTONIC guard of the
// upsert, so a late-landing re-emit of an older artifact can never replace a
// newer one. A run that walks several gates keeps one row per gate; the reader
// takes the newest, which is the gate the run is parked on.
//
// FK to agent_runs ON DELETE CASCADE — the agent_run_hitl_prompts /
// agent_run_test_sends sibling precedent (NOT the FK-less artifact_review_gates
// precedent): the row is meaningless without its run and needs no retention
// machinery of its own.
//
// ADDITIVE (one brand-new empty table + one index; migrations/README.md
// "Additive") — no artifact is REQUIRED. Shipped anyway (the core__0067 / 0072
// precedent) so the fresh-install and operator-upgrade paths stay aligned: an
// already-running instance never re-runs the bootstrap DDL, so without this
// module the table would exist on fresh installs only and every gate write on an
// upgraded instance would fail with `relation "…" does not exist`. The DDL
// MIRRORS the idempotent bootstrap leaf (agentRunHitlGatesSchemaQueries in
// src/lib/artifacts/artifact-review-gate-schema.ts, spread into
// buildCreateStoreSchemaQueries in the SAME PR) — a no-op on a bootstrap-seeded
// schema, ledger-faked on a fresh install, executed by `db migrate` on an
// existing deployment. Unqualified names ride the runner's search_path (the app
// schema); metadata-only DDL on an empty table, no noTransaction().
//
// SEQ 0093 — strictly greater than the max shipped seq on origin/main
// (core__0092 suggestion-decision-cas). SEQ IS PROVISIONAL: a concurrent lane
// may claim 0093 first, in which case a rename-only renumber is normal (FLAGGED
// for the coordinator's train). migrations/** is HIGH-RISK: owner approval
// required; the lane never merges.
//
// DOWN. Reversible in shape: a fresh addition, so dropping it restores the exact
// pre-0093 shape on any lineage (the index rides the table drop). HONEST COST:
// any durable gate rows for currently paused runs are lost, which returns those
// runs to the Redis-only behaviour this migration replaced — an operator-
// initiated `--down` accepts that (the table carries no data on a fresh install).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const agentRunHitlGatesDdlSql = `
  CREATE TABLE IF NOT EXISTS agent_run_hitl_gates (
    run_id          text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    review_task_id  text NOT NULL,
    x_renderer      text NOT NULL,
    input_schema    jsonb NOT NULL,
    gate_values     jsonb NOT NULL,
    field_name      text,
    materialized_at timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, review_task_id)
  );
  CREATE INDEX IF NOT EXISTS agent_run_hitl_gates_run_id_materialized_at_idx
    ON agent_run_hitl_gates (run_id, materialized_at DESC);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(agentRunHitlGatesDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: a fresh addition (the index rides the table drop). HONEST COST:
  // durable gate rows for currently paused runs are lost, returning those runs to
  // the Redis-only behaviour — an operator-initiated `--down` accepts that.
  pgm.sql(`DROP TABLE IF EXISTS agent_run_hitl_gates;`);
}
