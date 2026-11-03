// core__0119 — the publish-decision record (cinatra#4150). The operator-upgrade
// twin of the fresh-install bootstrap DDL (`publishDecisionSchemaQueries`, the
// pure-strings leaf src/lib/artifacts/publication-operation-schema.ts, spread into
// `buildCreateStoreSchemaQueries`), added in the SAME change — the core__0055
// precedent for a new table.
//
// ADDITIVE (a new empty table + its indexes): a no-op on a bootstrap-seeded schema.
// Unqualified names ride the runner's search_path; no noTransaction().
//
// SEQ 0119 — 0113 is the highest sequence on main at authoring time; 0114, 0115,
// 0116, 0117 and 0118 are claimed by other open changes. A concurrent change may
// land a sequence first, in which case a rename-only renumber is normal.

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
  // Reversible: the table is a fresh addition, so dropping it restores the exact
  // pre-0119 shape (indexes ride the table drop). HONEST COST: the decision history
  // is lost; an operator-initiated `--down` accepts that.
  pgm.sql(`DROP TABLE IF EXISTS agent_run_publish_decisions;`);
}
