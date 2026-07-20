// core__0061 — durable per-turn message CONTENT + structured pause/resume state
// (cinatra-ai/cinatra#1037 P5.6 drop-history, PR1 EXPAND).
//
// The drop-history ruling cuts /chat over to the structured
// assistant_threads/assistant_turns store (no backfill; new conversations keep
// full history). The grounded blocker: the structured store persists NO durable
// message content in Postgres — assistant_turns is metadata + a run_id pointer,
// message text lives only in the bounded/lossy Redis AG-UI event log, and the
// P2b mirror is deliberately content-less. A direct read-cutover would therefore
// degrade even NEW conversations. Fork-B (codex-converged) resolves it by first
// adding durable content persistence; this is the EXPAND leg of the
// expand → cutover → contract stack. It is ADDITIVE ONLY: no read changes, no
// deletions, no cutover marker, no legacy-write fence (those are PR2/PR3).
//
// Two additive structural changes:
//
//   • assistant_turns.content jsonb — the durable per-turn message content the
//     legacy chat_threads.payload has held until now. Captures the FULL message
//     object (role, content, parts, thinking, toolCalls, citations, attachments,
//     mentions — whatever /chat needs for faithful thread reconstruction, not
//     just terminal text). NULLABLE: pre-existing shadow rows stay contentless
//     (the P2b mirror never copied content), which is by design — the PR3 DROP
//     precondition checks content only on POST-cutover-marker rows. A CHECK
//     keeps the column a JSON object when present (its "required constraint").
//
//   • assistant_thread_pause_state — structured pause/resume storage. Today
//     `pausedParticipants` lives inside chat_threads.payload; this table holds
//     one row per (thread, paused participant). Presence == paused; resume
//     deletes the row. Written ALONGSIDE the legacy payload (which stays the
//     authoritative read source until the PR2 cutover), so this is a
//     write-through projection, not a read swap.
//
// WHY A MIGRATION. Both changes are additive — the bootstrap DDL
// (assistantThreadSchemaQueries in src/lib/assistant-thread-schema.ts, spread
// into buildCreateStoreSchemaQueries, same PR) provisions them on a fresh
// install, so a fresh DB is born at the target shape and ledger-fakes this
// migration. This module carries the SAME changes onto the operator upgrade path
// (a deployed DB that already has assistant_turns but not the content column or
// the pause table). Every statement is idempotent (ADD COLUMN IF NOT EXISTS,
// CREATE TABLE IF NOT EXISTS, add-constraint-if-absent), so re-running against a
// migrated OR a bootstrap-produced fresh schema is a no-op.
//
// IDEMPOTENT / LINEAGE-TOLERANT. The column add is `IF NOT EXISTS`; the CHECK
// and FK constraints are added only when absent (pg_constraint lookup against
// the runner's search_path via current_schema()); the pause table + its index
// are `IF NOT EXISTS`. Unqualified names resolve to the app schema the runner
// sets on search_path (what keeps worktree/branch schemas working).
//
// down() is a TRUE reverse (additive change, not a destructive clean-break —
// contrast core__0060): drop the pause table (+ its FK) and the content column
// (+ its CHECK). A revert loses only the newly-materialized durable content /
// structured pause rows; the legacy chat_threads.payload — still authoritative
// in this EXPAND leg — is untouched, so no user-visible history is lost.

const TURNS = "assistant_turns";
const TURN_CONTENT_COLUMN = "content";
const TURN_CONTENT_CHECK = "assistant_turns_content_object_check";

const PAUSE = "assistant_thread_pause_state";
const PAUSE_THREAD_FK = "assistant_thread_pause_state_thread_id_fkey";
const PAUSE_THREAD_IDX = "assistant_thread_pause_state_thread_idx";

/** Public relation identifiers (consumed by the shape test + PR2/PR3). */
export const ASSISTANT_TURNS_TABLE = TURNS;
export const ASSISTANT_TURN_CONTENT_COLUMN = TURN_CONTENT_COLUMN;
export const ASSISTANT_THREAD_PAUSE_STATE_TABLE = PAUSE;

/**
 * Add a constraint only when it is absent, resolved against the runner's
 * search_path (`current_schema()`). Postgres has no `ADD CONSTRAINT IF NOT
 * EXISTS`; this mirrors core__0026's guarded ALTER. All names are compile-time
 * constants of this module — nothing interpolates runtime input.
 */
function addConstraintIfAbsentSql(table, constraintName, ddl) {
  return `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = '${table}'
      AND c.conname = '${constraintName}'
  ) THEN
    ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} ${ddl};
  END IF;
END $$;`;
}

/**
 * SQL statements adding the durable-content column to assistant_turns:
 * idempotent nullable jsonb column + the JSON-object CHECK. Exported as data so
 * the shape test can assert the exact statements without a live DB. */
export function buildTurnContentColumnSql() {
  return [
    `ALTER TABLE ${TURNS} ADD COLUMN IF NOT EXISTS ${TURN_CONTENT_COLUMN} jsonb;`,
    addConstraintIfAbsentSql(
      TURNS,
      TURN_CONTENT_CHECK,
      `CHECK (${TURN_CONTENT_COLUMN} IS NULL OR jsonb_typeof(${TURN_CONTENT_COLUMN}) = 'object')`,
    ),
  ];
}

/**
 * SQL statements creating the structured pause/resume table: the table, its FK
 * to assistant_threads (ON DELETE CASCADE), and the per-thread read index.
 * One row per (thread_id, participant_id); presence == paused. Exported as data
 * for the shape test. */
export function buildPauseStateTableSql() {
  return [
    `CREATE TABLE IF NOT EXISTS ${PAUSE} (
      thread_id text NOT NULL,
      participant_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (thread_id, participant_id)
    );`,
    addConstraintIfAbsentSql(
      PAUSE,
      PAUSE_THREAD_FK,
      `FOREIGN KEY (thread_id) REFERENCES ${"assistant_threads"} (id) ON DELETE CASCADE`,
    ),
    `CREATE INDEX IF NOT EXISTS ${PAUSE_THREAD_IDX} ON ${PAUSE} (thread_id);`,
  ];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // 1. Durable per-turn content on assistant_turns (nullable + JSON-object CHECK).
  for (const stmt of buildTurnContentColumnSql()) pgm.sql(stmt);
  // 2. Structured pause/resume storage (parent FK → assistant_threads).
  for (const stmt of buildPauseStateTableSql()) pgm.sql(stmt);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // True reverse: drop the pause table (child of assistant_threads), then the
  // content column + its CHECK. Additive-change revert — the authoritative
  // legacy chat_threads.payload is untouched, so no user history is lost.
  pgm.sql(`DROP INDEX IF EXISTS ${PAUSE_THREAD_IDX};`);
  pgm.sql(`DROP TABLE IF EXISTS ${PAUSE};`);
  pgm.sql(`ALTER TABLE ${TURNS} DROP CONSTRAINT IF EXISTS ${TURN_CONTENT_CHECK};`);
  pgm.sql(`ALTER TABLE ${TURNS} DROP COLUMN IF EXISTS ${TURN_CONTENT_COLUMN};`);
}
