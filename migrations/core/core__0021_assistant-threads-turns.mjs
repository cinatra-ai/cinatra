// core__0021 — structured assistant threads + assistant_turns (cinatra-ai/cinatra#1037
// P2a, the assistant-runtime persistence half). Introduces the two typed tables
// that own the #1037-P2 side of the assistant-stream boundary named in the
// unified stream contract (@cinatra-ai/agent-ui-protocol, CONTRACT.md §1):
//
//   • assistant_threads — the structured thread: identity (owner, org), the
//                         bound assistant PRINCIPAL, the A2A `context_id`
//                         continuity handle, and ordering timestamps. The
//                         forward replacement for the legacy `chat_threads`
//                         JSON-payload "sync" table (which STAYS in place for
//                         now — the /chat persistence subroutes + chat_thread_send
//                         are rewired/deleted in P2b/P3, not here — so this is
//                         additive and there is no double-write yet).
//   • assistant_turns   — one AG-UI RUN in a thread (the contract's definition of
//                         a turn: the events between RUN_STARTED and its terminal
//                         frame). Carries the turn↔run linkage (`run_id`, which
//                         keys the durable Redis-Streams AG-UI event log
//                         `cinatra:a2a:events:{run_id}`) and the assistant
//                         PRINCIPAL attribution (I4). It deliberately does NOT
//                         store the event stream itself — the stream contract
//                         owns that durable log; this table is metadata +
//                         pointer, so there is NO double persistence model.
//
// WHY A MIGRATION. The tables are additive — the bootstrap DDL
// (buildCreateStoreSchemaQueries, same PR) creates them via `CREATE TABLE IF NOT
// EXISTS`, so a fresh install is born at the target shape and ledger-fakes this
// chain. This module carries the SAME creates onto the operator upgrade path (a
// deployed database that already has the schema but not these tables). Every
// statement is idempotent, so re-running against a migrated OR a
// bootstrap-produced fresh schema is a no-op.
//
// IDEMPOTENT / LINEAGE-TOLERANT. Tables + indexes are `IF NOT EXISTS`; the FK
// and CHECK constraints are added only when absent (looked up in pg_constraint
// against the runner's search_path via current_schema()). Unqualified table
// names resolve to the app schema the runner sets on search_path (what keeps
// worktree/branch schemas working).
//
// down() is a true reverse: drop assistant_turns (the child, FK-referencing
// side) first, then assistant_threads. A revert loses all structured thread /
// turn data by design — this is a structural addition, not a rename.

const THREADS = "assistant_threads";
const TURNS = "assistant_turns";
const TURNS_THREAD_FK = "assistant_turns_thread_id_fkey";
const TURNS_STATUS_CHECK = "assistant_turns_status_check";
const TURNS_ROLE_CHECK = "assistant_turns_role_check";
const THREADS_ORG_IDX = "assistant_threads_org_updated_idx";
const TURNS_THREAD_IDX = "assistant_turns_thread_created_idx";

/**
 * Add a constraint only when it is absent, resolved against the runner's
 * search_path (`current_schema()`). Postgres has no `ADD CONSTRAINT IF NOT
 * EXISTS`; this mirrors the bootstrap's guarded ALTER. All names are
 * compile-time constants of this module — nothing interpolates runtime input.
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

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // 1. assistant_threads — the structured thread (parent).
  pgm.sql(`CREATE TABLE IF NOT EXISTS ${THREADS} (
    id text PRIMARY KEY,
    assistant_user_id text,
    owner_user_id text,
    org_id text,
    title text,
    context_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`);

  // 2. assistant_turns — one AG-UI run in a thread (child, FK → threads).
  pgm.sql(`CREATE TABLE IF NOT EXISTS ${TURNS} (
    id text PRIMARY KEY,
    thread_id text NOT NULL,
    run_id text,
    assistant_user_id text,
    role text NOT NULL DEFAULT 'assistant',
    status text NOT NULL DEFAULT 'running',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`);

  // 3. Invariants (idempotent constraint adds).
  //    A turn belongs to a thread; deleting a thread cascades its turns.
  pgm.sql(
    addConstraintIfAbsentSql(
      TURNS,
      TURNS_THREAD_FK,
      `FOREIGN KEY (thread_id) REFERENCES ${THREADS} (id) ON DELETE CASCADE`,
    ),
  );
  //    Turn status mirrors the AG-UI run lifecycle terminal frames.
  pgm.sql(
    addConstraintIfAbsentSql(
      TURNS,
      TURNS_STATUS_CHECK,
      `CHECK (status IN ('running', 'completed', 'error'))`,
    ),
  );
  //    Author axis of the turn message.
  pgm.sql(
    addConstraintIfAbsentSql(
      TURNS,
      TURNS_ROLE_CHECK,
      `CHECK (role IN ('user', 'assistant'))`,
    ),
  );

  // 4. Read indexes: org-scoped recent-thread listing; per-thread turn ordering.
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS ${THREADS_ORG_IDX} ON ${THREADS} (org_id, updated_at DESC, id);`,
  );
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS ${TURNS_THREAD_IDX} ON ${TURNS} (thread_id, created_at, id);`,
  );
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Drop the child (FK-referencing) table first, then the parent.
  pgm.sql(`DROP INDEX IF EXISTS ${TURNS_THREAD_IDX};`);
  pgm.sql(`DROP INDEX IF EXISTS ${THREADS_ORG_IDX};`);
  pgm.sql(`DROP TABLE IF EXISTS ${TURNS};`);
  pgm.sql(`DROP TABLE IF EXISTS ${THREADS};`);
}
