// cinatra#3745: the run's bound step-tool graph, the burned artifact-review
// gates, and the artifact-review resume delivery's claim mark and send
// witness. Additive: two tables and two nullable columns; no row is written.
//
// Nullable legacy behaviour is enforced by the reader: a run without a bound
// graph cannot admit an outward action. Nothing is backfilled, so no
// authority is fabricated for an existing run.
export const outwardActionPolicyDdlSql = `
  CREATE TABLE IF NOT EXISTS agent_run_outward_action_policies (
    run_id text PRIMARY KEY, org_id text NOT NULL, execution_attempt_id text NOT NULL,
    policy jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS artifact_review_action_consumptions (
    gate_id text PRIMARY KEY, run_id text NOT NULL, org_id text NOT NULL,
    step_id text NOT NULL, tool_identity jsonb NOT NULL,
    executed_source_sha256 text NOT NULL, consumed_at timestamptz NOT NULL DEFAULT now()
  );
`;

// run_claimed_at: this gate's delivery moved the run pending_approval -> running
// (set and cleared with that edge, under the intent's lease). resume_task_result:
// the task the resume send returned, recorded before its handler runs; it never
// carries a run token.
export const resumeIntentRunClaimDdlSql = `
  ALTER TABLE artifact_review_resume_outbox ADD COLUMN IF NOT EXISTS run_claimed_at timestamptz;
  ALTER TABLE artifact_review_resume_outbox ADD COLUMN IF NOT EXISTS resume_task_result jsonb;
`;

// The draft-database guard. An unreleased draft of this change shipped its two
// migrations under the names below, and its resume delivery claimed a paused
// run (pending_approval -> running) before it sent, without a claim mark. Only
// a database that booted such a draft carries those ledger rows; a database
// from main never does, and the guard does nothing there.
//
// On a draft database:
//   - the boot is refused unless the operator states that every draft worker is
//     stopped (CINATRA_3745_DRAFT_DB_ACK=workers-stopped). A stopped worker
//     cannot claim after this check, so the count below stays true;
//   - with that statement, every claim the draft may have left without a mark
//     refuses the boot: an intent with no claim mark whose run is running,
//     whether it is still delivering or already dead-lettered (a dead-lettered
//     intent is never claimed again, so its run would stay running for good).
// A refusal changes nothing (the migration's transaction rolls back) and names
// the operator road: stop those runs with agent_run_stop, then boot again.
export const DRAFT_DB_ACK_ENV = "CINATRA_3745_DRAFT_DB_ACK";
export const DRAFT_DB_ACK_VALUE = "workers-stopped";
export function draftDatabaseGuardSql(ack) {
  return `
DO $guard$
DECLARE
  draft boolean := false;
  ack boolean := ${ack === true ? "true" : "false"};
  unmarked integer := 0;
BEGIN
  IF to_regclass('pgmigrations') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM pgmigrations m
       WHERE m.name IN ('core__0115_agent-run-outward-action-policy', 'core__0116_resume-intent-run-claim')
    ) INTO draft;
  END IF;
  IF draft THEN
    IF NOT ack THEN
      RAISE EXCEPTION 'core__0120: this database booted an unreleased draft of this migration; stop every draft worker, then boot again with ${DRAFT_DB_ACK_ENV}=${DRAFT_DB_ACK_VALUE}';
    END IF;
    SELECT count(*) INTO unmarked
      FROM artifact_review_resume_outbox o
      JOIN agent_runs r ON r.id = o.run_id
     WHERE o.run_claimed_at IS NULL AND r.status = 'running'
       AND (o.status = 'delivering' OR o.dead_lettered_at IS NOT NULL);
    IF unmarked > 0 THEN
      RAISE EXCEPTION 'core__0120: % resume intent(s) of a running run carry no claim mark (a draft delivery may have claimed them); stop those runs with agent_run_stop, then boot again', unmarked;
    END IF;
  END IF;
END
$guard$;
`;
}

export function up(pgm) {
  pgm.sql(outwardActionPolicyDdlSql);
  pgm.sql(resumeIntentRunClaimDdlSql);
  pgm.sql(draftDatabaseGuardSql(process.env[DRAFT_DB_ACK_ENV] === DRAFT_DB_ACK_VALUE));
}

// Dropping the burned gates would let an approval be used again, and dropping
// the claim columns would strand claimed runs. An automatic rollback refuses;
// a data-preserving downgrade needs its own reviewed migration.
export function down() {
  throw new Error("outward_action_policy_downgrade_requires_preserved_consumptions");
}
