// cinatra#3745: the resume delivery's durable claim mark and
// send witness. Additive and nullable; no row is rewritten.
export const resumeIntentRunClaimDdlSql = `
  ALTER TABLE artifact_review_resume_outbox ADD COLUMN IF NOT EXISTS run_claimed_at timestamptz;
  ALTER TABLE artifact_review_resume_outbox ADD COLUMN IF NOT EXISTS resume_task_result jsonb;
`;
// The rollout guard. core__0115 arrived, unreleased, with the claim-before-send
// delivery that this file repairs. If 0115 was applied in an EARLIER migration
// session than this one, that delivery may have run, and a row it claimed carries
// no mark: the new delivery would read it as another actor's resume and close it,
// stranding the run. Such a row stops the boot with its count and the operator
// road; it is never guessed at. 0115 applied in this same session sets the
// session mark 0115 writes (a deploy straight from main), and a schema with no
// such row passes. The mark is a session setting, not a timestamp, so no clock or
// time zone decides it.
export const resumeIntentRunClaimGuardSql = `
DO $guard$
DECLARE
  prior_session boolean := false;
  unmarked integer := 0;
BEGIN
  IF to_regclass('pgmigrations') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM pgmigrations m WHERE m.name = 'core__0115_agent-run-outward-action-policy'
    ) AND COALESCE(current_setting('cinatra.core_0115_this_session', true), '') <> 'on'
      INTO prior_session;
  END IF;
  IF prior_session THEN
    SELECT count(*) INTO unmarked
      FROM artifact_review_resume_outbox o
      JOIN agent_runs r ON r.id = o.run_id
     WHERE o.status = 'delivering' AND o.run_claimed_at IS NULL
       AND o.dead_lettered_at IS NULL AND r.status = 'running';
    IF unmarked > 0 THEN
      RAISE EXCEPTION 'core__0116: % resume intent(s) were claimed by the pre-0116 delivery and carry no claim mark; stop those runs with agent_run_stop, then boot again', unmarked;
    END IF;
  END IF;
END
$guard$;
`;
export function up(pgm) {
  pgm.sql(resumeIntentRunClaimDdlSql);
  pgm.sql(resumeIntentRunClaimGuardSql);
}
// Dropping the columns would erase live claim marks and strand claimed runs.
export function down() { throw new Error("resume_intent_run_claim_downgrade_strands_claimed_runs"); }
