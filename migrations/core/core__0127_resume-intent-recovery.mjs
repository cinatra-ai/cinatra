// core__0127 — the upgrade recovery of a declared review's paused run (cinatra#4476).
// The operator-upgrade twin of the fresh-install bootstrap CREATE TABLEs in
// `lifecycleInterceptionsSchemaQueries` (src/lib/artifacts/artifact-review-gate-schema.ts),
// added in the SAME pull request.
//
// WHY. cinatra#4312 bounded the resume claim by `max_attempts` and gave the dead-letter
// pass its first production caller. Main had neither, so it re-claimed an undelivered
// intent after each lease without a bound. An intent main left at or above its
// `max_attempts`, or one that the old application takes there while it still serves
// after this migration, is dead-lettered by the first sweep of the new code, and its
// paused run then has no live intent. A declared review's family has no free gate for
// a new intent: each gate decided by approve or reject already holds its own (the
// primary key), and main settled no declared leg as changes requested. So the recovery
// (packages/agents/src/declared-review-recovery.ts, run by the resume sweep) gives that
// family's newest decision ONE new budget on its own row, once per pause.
//
// This migration only creates the two tables and one index, and writes the upgrade's
// time:
//   - `artifact_review_resume_recovery`: one row per pause the recovery wrote for, its
//     once marker (primary key run id + base review task id);
//   - `artifact_review_resume_recovery_epoch`: one row, `upgraded_at`. The recovery acts
//     only when the row exists (a fresh install has none) and only on a pause whose
//     legs were all created before it, or whose lineage carries an old writer's
//     attempt on a reopen gate (a deploy-window state the new code cannot write). Its
//     `cursor_run_id` and `high_water_run_id` (null at first) are where the recovery's
//     next page of paused runs starts and where its current cycle ends;
//   - `agent_runs_pending_approval_id_idx`: a partial index of the paused runs' ids. One
//     pass of the recovery reads one page of it (at most 50 runs), in id order after the
//     cursor and up to the cycle's mark, so a pass reads a bounded set of runs, and a
//     cycle ends once it read the runs up to its mark, whatever their outcomes were.
//     Built without CONCURRENTLY, as core__0111 builds its agent_runs index.
// It writes no existing row. The two ALTERs give the cursor columns to an epoch table an
// earlier shape of this change created (`CREATE TABLE IF NOT EXISTS` keeps such a table).
//
// DOWN drops the index only. It KEEPS both tables and their rows, so the recovery stays
// at most once, ever, across a rollback and a later redeploy: the markers are the record
// of each pause already written for (dropping them would let a later `up` re-arm or carry
// for that pause again), and the epoch row keeps the first upgrade's time (a new time
// would read the pauses made while the change was rolled back as older than the upgrade).
// The code before this change reads neither table. An operator who removes this change
// for good drops the two tables by hand.
//
// SEQ 0127 — above core__0125 (cinatra#4339, which this change builds on), the highest
// number on main when this change took it. If this number or a higher one reaches
// main first, this change takes the next free number before it merges.
//
// Unqualified names ride the runner's search_path (the app schema).

/** Idempotent DDL mirroring the bootstrap CREATE TABLEs and index — safe to run after them. */
export const resumeIntentRecoveryDdlSql = `
  CREATE TABLE IF NOT EXISTS artifact_review_resume_recovery (
    run_id              text NOT NULL,
    base_review_task_id text NOT NULL,
    road                text NOT NULL CHECK (road IN ('rearm', 'carry')),
    gate_id             text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, base_review_task_id)
  );
  CREATE TABLE IF NOT EXISTS artifact_review_resume_recovery_epoch (
    id                text PRIMARY KEY CHECK (id = 'cinatra-4476'),
    upgraded_at       timestamptz NOT NULL DEFAULT now(),
    cursor_run_id     text,
    high_water_run_id text
  );
  ALTER TABLE artifact_review_resume_recovery_epoch ADD COLUMN IF NOT EXISTS cursor_run_id text;
  ALTER TABLE artifact_review_resume_recovery_epoch ADD COLUMN IF NOT EXISTS high_water_run_id text;
  CREATE INDEX IF NOT EXISTS agent_runs_pending_approval_id_idx
    ON agent_runs (id) WHERE status = 'pending_approval';
`;

/** The upgrade's time, written once: a rerun keeps the first time. */
export const resumeIntentRecoveryEpochSql = `
  INSERT INTO artifact_review_resume_recovery_epoch (id) VALUES ('cinatra-4476')
  ON CONFLICT (id) DO NOTHING;
`;

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function up(pgm) {
  pgm.sql(resumeIntentRecoveryDdlSql);
  pgm.sql(resumeIntentRecoveryEpochSql);
}

/** Drops the index only; the two tables and their rows stay (see DOWN above).
 * @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS agent_runs_pending_approval_id_idx;
  `);
}
