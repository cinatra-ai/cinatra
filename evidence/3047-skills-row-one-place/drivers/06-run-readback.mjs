// THE RUN, READ BACK OUT OF ITS OWN ROWS. Every number in RUN-READBACK.md is
// SELECTED here, never described. Reads only; writes nothing.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "pg";

const DB = process.env.SUPABASE_DB_URL;
const RUN = process.env.WALK_RUN_ID;
const OUT = process.env.OUT_JSON;
if (!DB || !RUN || !OUT) throw new Error("the readback driver needs SUPABASE_DB_URL, WALK_RUN_ID and OUT_JSON");

const db = new Client({ connectionString: DB });
await db.connect();
const one = async (sql, params = []) => (await db.query(sql, params)).rows;
const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0]?.n ?? 0);
const safe = async (fn, label) => { try { return await fn(); } catch (e) { return { unavailable: `${label}: ${String(e.message).slice(0, 160)}` }; } };

const out = {
  at: new Date().toISOString(),
  run: (await one(
    `SELECT id, status, source_type, human_present, error, created_at, template_id, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref
       FROM cinatra.agent_runs WHERE id=$1`, [RUN]))[0] ?? null,
  hitlGates: await one(
    `SELECT review_task_id, field_name, x_renderer, created_at FROM cinatra.agent_run_hitl_gates WHERE run_id=$1 ORDER BY created_at`, [RUN]),
  artifactReviewGates: await one(
    `SELECT id, review_task_id, status, disposition, created_at, resolved_at FROM cinatra.artifact_review_gates WHERE run_id=$1 ORDER BY created_at`, [RUN]),
  recommendationPark: await safe(() => one(
    `SELECT id, status, created_at, updated_at FROM cinatra.run_recommendation_parks WHERE run_id=$1`, [RUN]), "run_recommendation_parks"),
  selectedSkillRevisions: await safe(() => one(
    `SELECT skill_id, selection_source FROM cinatra.run_selected_skill_revisions WHERE run_id=$1 ORDER BY skill_id`, [RUN]), "run_selected_skill_revisions"),
  skillsUsed: await safe(() => one(
    `SELECT skill_id FROM cinatra.agent_run_skills_used WHERE run_id=$1 ORDER BY skill_id`, [RUN]), "agent_run_skills_used"),
  recommendationSkips: await safe(() => one(
    `SELECT skill_id FROM cinatra.run_recommendation_skips WHERE run_id=$1 ORDER BY skill_id`, [RUN]), "run_recommendation_skips"),
  assignedSkills: await one(
    `SELECT skill_id, owner_type, owner_id FROM cinatra.custom_skill_assignments WHERE agent_id=$1 ORDER BY skill_id`,
    [process.env.WALK_AGENT_PKG ?? "@cinatra-ai/blog-draft-writer-agent"]),
  installedExtensions: await one(
    `SELECT package_name, status, version FROM cinatra.installed_extension
      WHERE package_name IN ('@cinatra-ai/blog-draft-writer-agent','@cinatra-ai/blog-post-artifact','@cinatra-ai/context-selection-agent')
      ORDER BY package_name`),
  assistantTurns: await count(`SELECT count(*) AS n FROM cinatra.assistant_turns WHERE role='assistant'`),
  turnsCarryingRecommendationHold: await count(
    `SELECT count(*) AS n FROM cinatra.assistant_turns WHERE content::text LIKE '%recommendation_hold%'`),
  runsOnThisInstance: await count(`SELECT count(*) AS n FROM cinatra.agent_runs`),
  verificationRecords: await safe(() => count(`SELECT count(*) AS n FROM cinatra.artifact_verification_records`), "artifact_verification_records"),
  llmUsage: await safe(() => count(`SELECT count(*) AS n FROM cinatra.llm_usage`), "llm_usage"),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 1));
await db.end();
