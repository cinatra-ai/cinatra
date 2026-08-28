// THE RUN, READ BACK OUT OF ITS OWN ROWS after the round — no value here is
// described, every one is selected.
import { Client } from "pg";
const DB = process.env.SUPABASE_DB_URL, RUN = process.env.WALK_RUN_ID;
const c = new Client({ connectionString: DB }); await c.connect();
const one = async (t, v = []) => (await c.query(t, v)).rows;
const out = {};
out.run = (await one(`select id,status,created_at,started_at,completed_at,lifecycle_moment,lifecycle_card_kind,lifecycle_card_ref,source_type,human_present,left(coalesce(error,''),300) as error from cinatra.agent_runs where id=$1`, [RUN]))[0];
out.gates = await one(`select review_task_id, field_name, x_renderer, created_at from cinatra.agent_run_hitl_gates where run_id=$1 order by created_at`, [RUN]);
out.selectedSkillRevisions = await one(`select skill_id from cinatra.run_selected_skill_revisions where run_id=$1 order by 1`, [RUN]);
out.assignedSkills = await one(`select skill_id, agent_id, owner_type from cinatra.custom_skill_assignments order by skill_id`);
out.turnsInTheRunThread = await one(`select id, role, created_at from cinatra.assistant_turns where thread_id=$1 order by created_at`, [process.env.WALK_THREAD_ID]);
out.turnsCarryingAScheduleCard = (await one(`select count(*) n from cinatra.assistant_turns where content::text like '%trigger_schedule_proposal%'`))[0].n;
out.turnsCarryingARecommendationCard = (await one(`select count(*) n from cinatra.assistant_turns where content::text like '%recommendation_hold%'`))[0].n;
out.turnsCarryingAHitlCard = (await one(`select count(*) n from cinatra.assistant_turns where content::text like '%agent_hitl_screen%'`))[0].n;
out.triggers = await one(`select count(*) n from cinatra.agent_run_triggers where run_id=$1`, [RUN]);
out.providerUsage = await one(`select provider, model, operation, count(*) calls, sum(input_tokens) input_tokens, sum(output_tokens) output_tokens from cinatra.llm_usage group by 1,2,3 order by 4 desc`).catch(() => []);
out.installedForTheRun = await one(`select package_name, status, version from cinatra.installed_extension where package_name = ANY($1)`, [["@cinatra-ai/blog-draft-writer-agent", "@cinatra-ai/context-selection-agent"]]);
console.log(JSON.stringify(out, null, 2));
await c.end();
