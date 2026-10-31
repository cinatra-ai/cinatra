// Nullable legacy behavior is enforced by the reader:
// missing binding cannot admit an outward action. No backfilled authority.
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
// A session mark core__0116's rollout guard reads: this module ran in the same
// migration session as 0116, so no delivery of the pre-0116 kind ran between them.
export const core0115SessionMarkSql = `SELECT set_config('cinatra.core_0115_this_session', 'on', false);`;
export function up(pgm) { pgm.sql(outwardActionPolicyDdlSql); pgm.sql(core0115SessionMarkSql); }
// Dropping burned gates would permit re-admission. Require a separately
// authorized data-preserving downgrade; automatic rollback must refuse.
export function down() { throw new Error("outward_action_policy_downgrade_requires_preserved_consumptions"); }
