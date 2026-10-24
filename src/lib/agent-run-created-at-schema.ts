// Bootstrap DDL for `agent_runs.created_at` (cinatra#2911) — a pure string
// builder with ZERO imports, so `drizzle-store.ts` can compose it synchronously
// (same leaf shape as `review-island-grant-schema.ts`).
//
// WHAT THE COLUMN IS. `created_at` records when a run was REQUESTED. The insert
// default is its ONLY legitimate writer (`packages/agents/src/schema.ts`,
// `.notNull().defaultNow()`; the insert in `packages/agents/src/store.ts` never
// names the column). Run listings order by it — the descending index
// `agent_runs_source_lookup_idx` is `(source_type, source_id, created_at DESC)`
// — and the requested-to-started interval is derived from it.
//
// THE DEFECT THIS SHAPE FIXES. These statements used to sit inline in
// `buildCreateStoreSchemaQueries` as
//
//     ALTER TABLE … ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()
//     UPDATE … SET created_at = COALESCE(started_at, completed_at, created_at)
//
// — an UNGUARDED whole-table rewrite with no WHERE clause. The surrounding DDL
// is idempotent (IF NOT EXISTS); that UPDATE was idempotent only against FIXED
// inputs, and `started_at` / `completed_at` are populated LATER in a run's life.
// The bootstrap list is REPLAYED once per fresh server process — the
// `globalThis` flag and the pid-keyed done-marker in `postgres-schema-init.ts`
// suppress it only WITHIN one process, not across restarts — so each replay
// recomputed `created_at` from data that did not exist when the row was
// inserted. A run that reached `running` had its creation time collapsed onto
// `started_at`; a run that FAILED before it ever started had it collapsed onto
// `completed_at`, so the run reported its own end time as its creation time and
// the child rows it owns (its continuation park) appeared to predate it. The
// loss was silent and irreversible: the original value is not recoverable.
//
// THE SHAPE. `created_at` is IMMUTABLE after insert. The column is added
// NULLABLE and WITHOUT a default, which is exactly what makes "never had a
// creation timestamp" distinguishable from "already carries one": a row that
// predates the column lands on NULL, and a row that already has a value is left
// alone because the backfill narrows on `created_at IS NULL`. The default and
// the NOT NULL are applied AFTERWARDS, so the column's final shape is unchanged
// (timestamptz NOT NULL DEFAULT now()) and the insert path keeps relying on the
// database default. Adding the column WITH a default would defeat the guard:
// PostgreSQL fills every existing row with that default, so nothing would be
// NULL and no row would be distinguishable from a row that never had a value.
//
// ON REPLAY all three statements are no-ops: the column exists (ADD COLUMN IF
// NOT EXISTS), no row is NULL (the backfill matches nothing), and the default
// and the constraint are already in place (SET NOT NULL skips its validation
// scan when `attnotnull` is already set). A present `created_at` can no longer
// be recomputed from any other column.
//
// FRESH INSTALL. `agent_runs` is created a few statements earlier by a
// CREATE TABLE that does not carry `created_at`, so on a fresh schema this runs
// against an EMPTY table: the nullable window spans no rows and no concurrent
// insert can observe it.
//
// OPERATOR UPGRADE. Migration twin
// `migrations/core/core__0096_agent-run-created-at-immutable.mjs`. The versioned
// chain carried NOTHING for this column — an operator database only ever
// received it from the bootstrap, which runs ahead of the chain — so the twin
// ships these same three idempotent statements against the runner's search_path.

export function agentRunCreatedAtSchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    { text: `ALTER TABLE "${s}"."agent_runs" ADD COLUMN IF NOT EXISTS created_at timestamptz` },
    { text: `UPDATE "${s}"."agent_runs" SET created_at = COALESCE(started_at, completed_at, now()) WHERE created_at IS NULL` },
    { text: `ALTER TABLE "${s}"."agent_runs" ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN created_at SET NOT NULL` },
  ];
}

// Independent starter provenance is another immutable run-creation fact.
// Keeping its bootstrap twin on the existing pure run-schema edge preserves
// the locked sign-in graph; neither this column nor created_at is rewritten.
// Pure bootstrap leaf and operator-upgrade twin: distinct from parent_run_id.
// Additive, nullable, no backfill, no cascade or rewrite of existing records.
export function agentRunStartedBySchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    { text: `ALTER TABLE "${s}"."agent_runs" ADD COLUMN IF NOT EXISTS started_by_run_id text` },
    { text: `CREATE INDEX IF NOT EXISTS agent_runs_started_by_run_id_idx ON "${s}"."agent_runs" (started_by_run_id, org_id, created_at) WHERE started_by_run_id IS NOT NULL` },
  ];
}

// The PAUSE CLAIM columns (cinatra#4245): a generation-stamped lease on a paused
// run's own row. Migration twin core__0116, which carries the same statements
// and explains them. Inert until a later change reads them: no backfill. Each
// statement runs on its own (the bootstrap runs no transaction), so the table
// scan happens only in VALIDATE CONSTRAINT under SHARE UPDATE EXCLUSIVE; each
// CHECK is added NOT VALID while pg_constraint lacks its name and validated
// while it is still NOT VALID, so a replay re-scans nothing.
export function agentRunPauseClaimSchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""'); // identifier-position quote
  // The regclass text is a quoted identifier inside a literal: quote the
  // identifier first, then escape the literal (a schema like team"blue).
  const rel = `"${s}"."agent_runs"`.replaceAll("'", "''");
  const guardedCheck = (name: string, body: string) => `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = '${name}'
      AND conrelid = '${rel}'::regclass
  ) THEN
    ALTER TABLE "${s}"."agent_runs"
      ADD CONSTRAINT ${name}
      CHECK (${body}) NOT VALID;
  END IF;
END $$`;
  const guardedValidate = (name: string) => `DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = '${name}'
      AND conrelid = '${rel}'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE "${s}"."agent_runs" VALIDATE CONSTRAINT ${name};
  END IF;
END $$`;
  return [
    { text: `ALTER TABLE "${s}"."agent_runs" ADD COLUMN IF NOT EXISTS pause_generation bigint NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS pause_claim_token text, ADD COLUMN IF NOT EXISTS pause_claim_phase text, ADD COLUMN IF NOT EXISTS pause_claim_expires_at timestamptz` },
    { text: guardedCheck("agent_runs_pause_claim_phase_chk", "pause_claim_phase IS NULL OR pause_claim_phase IN ('claimed','sending','changes_requested')") },
    { text: guardedCheck("agent_runs_pause_claim_shape_chk", "(pause_claim_token IS NULL AND pause_claim_phase IS NULL AND pause_claim_expires_at IS NULL) OR (pause_claim_token IS NOT NULL AND pause_claim_phase IS NOT NULL AND (pause_claim_phase = 'changes_requested') = (pause_claim_expires_at IS NULL))") },
    { text: guardedValidate("agent_runs_pause_claim_phase_chk") },
    { text: guardedValidate("agent_runs_pause_claim_shape_chk") },
  ];
}
