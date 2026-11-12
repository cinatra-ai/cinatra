// core__0119 — the publish-decision record (cinatra#4150): the operator-upgrade twin of the
// bootstrap DDL (`publishDecisionSchemaQueries` in src/lib/artifacts/publication-operation-schema.ts).
// Additive and idempotent: a no-op on a bootstrapped schema. Unqualified names ride the runner's
// search_path. SEQ 0119: 0113 is main's highest; open changes claim 0114 to 0118.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const agentRunPublishDecisionsDdlSql = `
  CREATE TABLE IF NOT EXISTS agent_run_publish_decisions (
    id               text PRIMARY KEY,
    org_id           text,
    run_id           text NOT NULL,
    node_id          text NOT NULL,
    gate_task_id     text NOT NULL,
    a2a_context_id   text,
    status           text NOT NULL DEFAULT 'parked',
    surfaced_values  text NOT NULL,
    decided_by       text,
    decided_at       timestamptz,
    decision_note    text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    CONSTRAINT agent_run_publish_decisions_status_check
      CHECK (status IN ('parked', 'released', 'declined', 'expired', 'run_ended'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_run_publish_decisions_park_uniq
    ON agent_run_publish_decisions (run_id, node_id, gate_task_id);
  CREATE INDEX IF NOT EXISTS agent_run_publish_decisions_due_idx
    ON agent_run_publish_decisions (expires_at) WHERE status = 'parked';
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(agentRunPublishDecisionsDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Restores the pre-0119 shape (the indexes go with the table); the decision history is lost.
  pgm.sql(`DROP TABLE IF EXISTS agent_run_publish_decisions;`);
}
