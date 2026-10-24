// core__0116 — the pause claim columns (cinatra#4245, PR A1: columns only).
// Operator-upgrade twin of the fresh-install bootstrap DDL
// (`agentRunPauseClaimSchemaQueries` in src/lib/agent-run-created-at-schema.ts
// and the `paused_run_generation` line of `lifecycleRepairSchemaQueries` in
// src/lib/artifacts/artifact-review-gate-schema.ts), shipped in the SAME change.
//
// WHAT. A run paused at `pending_approval` gets a generation-stamped lease on
// its own row, so a resume, a stop and a change request serialize on one row
// lock: `pause_generation` counts every change of what the run waits at, and
// the claim triple (`pause_claim_token`, `pause_claim_phase`,
// `pause_claim_expires_at`) says who holds the pause and until when.
// `lifecycle_repair.paused_run_generation` records which generation a change
// request ended. NOTHING READS OR WRITES THEM YET: this change is inert.
//
// NO BACKFILL. Existing rows read generation 0 and no claim. The CHECKs are
// added over columns that are NULL on every existing row, so they cannot fail
// and change no stored value. The manifest marks the change destructive only
// because the repository convention counts a NOT NULL column and a CHECK added
// to an existing table as user-land-affecting.
//
// LOCKS (pre-1 MUST-FIX C4). `up` runs OUTSIDE a transaction
// (`pgm.noTransaction()`), one statement at a time, so no lock outlives its
// own statement. The statements that take ACCESS EXCLUSIVE touch the catalog
// only: the column add (a constant default needs no rewrite and no scan) and
// each CHECK added NOT VALID (no scan; new writes are checked at once). The
// table scan happens in VALIDATE CONSTRAINT, which holds only SHARE UPDATE
// EXCLUSIVE, so reads and writes go on while it runs. Both CHECKs end
// validated. A crash between two statements leaves no ledger row; the replay
// finishes the work, because every statement is guarded.
//
// IDEMPOTENT. ADD COLUMN IF NOT EXISTS; each CHECK is added only while
// pg_constraint holds no constraint of its name, and validated only while it
// is still NOT VALID, so a replay re-scans nothing.
//
// DOWN drops the two constraints, then the five columns. It discards any live
// claim, so it is safe only once no deployed code reads the columns.
//
// Unqualified names ride the runner's search_path (the app schema), matching
// every sibling module in this chain.

export const PAUSE_CLAIM_PHASES = ["claimed", "sending", "changes_requested"];

const phaseList = PAUSE_CLAIM_PHASES.map((p) => `'${p}'`).join(",");

/** The CHECKs, by name; the bootstrap leaf carries the same two. */
export const pauseClaimPhaseCheckSql = `pause_claim_phase IS NULL OR pause_claim_phase IN (${phaseList})`;
// No claim: token, phase and expiry are all NULL (pre-1 MUST-FIX C1/C6: an
// expiry alone is refused). A claim: token and phase are set, and only the
// changes_requested end mark has no expiry.
export const pauseClaimShapeCheckSql =
  `(pause_claim_token IS NULL AND pause_claim_phase IS NULL AND pause_claim_expires_at IS NULL) OR (pause_claim_token IS NOT NULL AND pause_claim_phase IS NOT NULL AND (pause_claim_phase = 'changes_requested') = (pause_claim_expires_at IS NULL))`;

const guardedCheck = (name, body) => `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = '${name}'
      AND conrelid = 'agent_runs'::regclass
  ) THEN
    ALTER TABLE agent_runs
      ADD CONSTRAINT ${name}
      CHECK (${body}) NOT VALID;
  END IF;
END $$`;

const guardedValidate = (name) => `DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = '${name}'
      AND conrelid = 'agent_runs'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE agent_runs VALIDATE CONSTRAINT ${name};
  END IF;
END $$`;

/** One statement per entry, in order; `up` runs them as they stand. */
export const pauseClaimDdlStatements = [
  `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS pause_generation bigint NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS pause_claim_token text, ADD COLUMN IF NOT EXISTS pause_claim_phase text, ADD COLUMN IF NOT EXISTS pause_claim_expires_at timestamptz`,
  guardedCheck("agent_runs_pause_claim_phase_chk", pauseClaimPhaseCheckSql),
  guardedCheck("agent_runs_pause_claim_shape_chk", pauseClaimShapeCheckSql),
  guardedValidate("agent_runs_pause_claim_phase_chk"),
  guardedValidate("agent_runs_pause_claim_shape_chk"),
  `ALTER TABLE lifecycle_repair ADD COLUMN IF NOT EXISTS paused_run_generation bigint`,
];

export const pauseClaimDownStatements = [
  `ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_pause_claim_shape_chk, DROP CONSTRAINT IF EXISTS agent_runs_pause_claim_phase_chk`,
  `ALTER TABLE agent_runs DROP COLUMN IF EXISTS pause_claim_expires_at, DROP COLUMN IF EXISTS pause_claim_phase, DROP COLUMN IF EXISTS pause_claim_token, DROP COLUMN IF EXISTS pause_generation`,
  `ALTER TABLE lifecycle_repair DROP COLUMN IF EXISTS paused_run_generation`,
];

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql" | "noTransaction">} pgm */
export function up(pgm) {
  // One autocommit statement each: see LOCKS above.
  pgm.noTransaction();
  for (const statement of pauseClaimDdlStatements) pgm.sql(statement);
}

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function down(pgm) {
  for (const statement of pauseClaimDownStatements) pgm.sql(statement);
}
