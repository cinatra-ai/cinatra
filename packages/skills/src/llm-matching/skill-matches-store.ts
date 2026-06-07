/**
 * Drizzle/pg reads + writes for the skill_matches table.
 *
 * The stale-write guard and manual-row protection live in upsert.ts (the
 * caller). This module is an unconditional INSERT ... ON CONFLICT UPDATE so
 * callers can compose application-side policy on top.
 */

import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import type { SkillMatchRow, MatchSource, MatchStatus } from "./types";

type RawRow = Record<string, unknown>;

function rowFromDb(raw: RawRow): SkillMatchRow {
  // numeric(4,3) comes back as a string from node-postgres (no float coercion).
  // null is preserved for manual rows where score is intentionally absent.
  const scoreRaw = raw.score;
  let score: number | null;
  if (scoreRaw === null || scoreRaw === undefined) score = null;
  else if (typeof scoreRaw === "string") score = Number.parseFloat(scoreRaw);
  else if (typeof scoreRaw === "number") score = scoreRaw;
  else score = null;

  return {
    agentId: String(raw.agent_id),
    skillId: String(raw.skill_id),
    source: String(raw.source) as MatchSource,
    matched: Boolean(raw.matched),
    score,
    rationale: raw.rationale === null || raw.rationale === undefined ? null : String(raw.rationale),
    evaluatorVersion: String(raw.evaluator_version),
    agentInputHash: String(raw.agent_input_hash),
    skillInputHash: String(raw.skill_input_hash),
    status: String(raw.status) as MatchStatus,
    errorCode:
      raw.error_code === null || raw.error_code === undefined ? null : String(raw.error_code),
    errorMessage:
      raw.error_message === null || raw.error_message === undefined
        ? null
        : String(raw.error_message),
    evaluatedAt: new Date(raw.evaluated_at as string | number | Date),
    jobStartedAt: new Date(raw.job_started_at as string | number | Date),
  };
}

function quotedSchema(): string {
  return `"${postgresSchema.replaceAll('"', '""')}"`;
}

export async function upsertSkillMatch(row: SkillMatchRow): Promise<void> {
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  // score may be null only for manual rows (CHECK constraint in DDL).
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `
          INSERT INTO ${schema}."skill_matches" (
            agent_id, skill_id, source, matched, score, rationale,
            evaluator_version, agent_input_hash, skill_input_hash,
            status, error_code, error_message,
            evaluated_at, job_started_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (agent_id, skill_id) DO UPDATE SET
            source = EXCLUDED.source,
            matched = EXCLUDED.matched,
            score = EXCLUDED.score,
            rationale = EXCLUDED.rationale,
            evaluator_version = EXCLUDED.evaluator_version,
            agent_input_hash = EXCLUDED.agent_input_hash,
            skill_input_hash = EXCLUDED.skill_input_hash,
            status = EXCLUDED.status,
            error_code = EXCLUDED.error_code,
            error_message = EXCLUDED.error_message,
            evaluated_at = EXCLUDED.evaluated_at,
            job_started_at = EXCLUDED.job_started_at
        `,
        values: [
          row.agentId,
          row.skillId,
          row.source,
          row.matched,
          row.score,
          row.rationale,
          row.evaluatorVersion,
          row.agentInputHash,
          row.skillInputHash,
          row.status,
          row.errorCode,
          row.errorMessage,
          row.evaluatedAt.toISOString(),
          row.jobStartedAt.toISOString(),
        ],
      },
    ],
  });
}

export async function readSkillMatch(
  agentId: string,
  skillId: string,
): Promise<SkillMatchRow | null> {
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT * FROM ${schema}."skill_matches" WHERE agent_id = $1 AND skill_id = $2`,
        values: [agentId, skillId],
      },
    ],
  });
  if (!result.rows || result.rows.length === 0) return null;
  return rowFromDb(result.rows[0]);
}

export async function readSkillMatchesByAgent(agentId: string): Promise<SkillMatchRow[]> {
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        // Deterministic recommender ordering. Without an explicit ORDER BY,
        // Postgres returns rows in arbitrary (heap/plan-dependent) order, so
        // the resolved skill list and Anthropic rank-and-truncate-to-8
        // keep/drop set could differ across identical-DB-state calls. Order
        // by recommender score DESC (highest-confidence match first; this is
        // the "recommender-scored" tier the delivery adapter's selectionReason
        // names), NULLS LAST (manual rows have a null score by DDL CHECK), with
        // a stable lexicographic skill_id tiebreak so the total order is a pure
        // function of DB state.
        text: `SELECT * FROM ${schema}."skill_matches" WHERE agent_id = $1 ORDER BY score DESC NULLS LAST, skill_id ASC`,
        values: [agentId],
      },
    ],
  });
  return (result.rows ?? []).map(rowFromDb);
}

export async function readSkillMatchesBySkill(skillId: string): Promise<SkillMatchRow[]> {
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT * FROM ${schema}."skill_matches" WHERE skill_id = $1`,
        values: [skillId],
      },
    ],
  });
  return (result.rows ?? []).map(rowFromDb);
}

/**
 * Read every matched-true ok row.
 * Used by `matchAgentsToSkills()` to project the canonical match table
 * back into the legacy `AgentSkillMatch` shape.
 */
export async function readAllMatched(): Promise<SkillMatchRow[]> {
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT * FROM ${schema}."skill_matches" WHERE matched = true AND status = 'ok'`,
        values: [],
      },
    ],
  });
  return (result.rows ?? []).map(rowFromDb);
}

/**
 * Random sample for the drift sampler.
 *
 * Selects up to `sampleSize` rows where `source = 'llm' AND status = 'ok'`.
 * Rule rows (deterministic by definition) and manual rows (operator-pinned)
 * are intentionally excluded — they cannot drift because they are not
 * generated by the LLM. Error rows are excluded so the sampler does not
 * thrash on a permanently-broken pair.
 *
 * Uses `ORDER BY random()` which is a sequential scan; acceptable because
 * the sampler runs once per day with a tiny `sampleSize` (5) and the
 * `skill_matches` table is bounded by `agents × non-agent-non-system skills`
 * (low thousands at the upper end of any realistic Cinatra deployment).
 * For larger scale, switch to TABLESAMPLE BERNOULLI.
 */
export async function readRandomLlmOkMatches(sampleSize: number): Promise<SkillMatchRow[]> {
  if (sampleSize <= 0) return [];
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT * FROM ${schema}."skill_matches" WHERE source = 'llm' AND status = 'ok' ORDER BY random() LIMIT $1`,
        values: [sampleSize],
      },
    ],
  });
  return (result.rows ?? []).map(rowFromDb);
}

export async function deleteSkillMatchesForSkill(skillId: string): Promise<void> {
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `DELETE FROM ${schema}."skill_matches" WHERE skill_id = $1`,
        values: [skillId],
      },
    ],
  });
}

export async function deleteSkillMatchesForAgent(agentId: string): Promise<void> {
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `DELETE FROM ${schema}."skill_matches" WHERE agent_id = $1`,
        values: [agentId],
      },
    ],
  });
}
