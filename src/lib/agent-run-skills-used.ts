/**
 * agent_run_skills_used ledger access.
 *
 * Per-run snapshot of which skills were resolved + invoked during a run.
 *
 * Two write paths:
 *   - Snapshot at run start: snapshotSkillsAtRunStart() inserts the resolved
 *     skill set (from skills_installed_resolve_for_agent) with
 *     invocation_count=0. Idempotent on (run_id, skill_id).
 *   - Increment on invocation: incrementSkillInvocation() upserts +
 *     increments invocation_count. Called by /api/llm-bridge when a skill
 *     is resolved during an LLM step.
 *
 * Read path:
 *   - listSkillsUsedForRun() — Skills tab in the agent run detail page.
 */
import "server-only";

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";

// SkillKind mirrors the agent_run_skills_used CHECK constraint. GitHub-installed
// skills are emitted as kind=installed.
export type SkillKind = "custom" | "installed" | "builtin";

export type AgentRunSkillUsed = {
  id: string;
  runId: string;
  skillId: string;
  skillKind: SkillKind;
  firstInvokedAt: string;
  invocationCount: number;
};

export function snapshotSkillsAtRunStart(input: {
  runId: string;
  skills: Array<{ skillId: string; skillKind: SkillKind }>;
}): void {
  if (input.skills.length === 0) return;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  // Build a single multi-row insert with ON CONFLICT DO NOTHING so re-running
  // the snapshot is idempotent (e.g. on resume after pending_input).
  const valuesSql: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const s of input.skills) {
    valuesSql.push(`($${p++}, $${p++}, $${p++}, 0)`);
    params.push(input.runId, s.skillId, s.skillKind);
  }
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO "${schema.replaceAll('"', '""')}"."agent_run_skills_used"
                 (run_id, skill_id, skill_kind, invocation_count)
               VALUES ${valuesSql.join(", ")}
               ON CONFLICT (run_id, skill_id) DO NOTHING`,
        values: params,
      },
    ],
  });
}

export function incrementSkillInvocation(input: {
  runId: string;
  skillId: string;
  skillKind: SkillKind;
}): void {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO "${schema.replaceAll('"', '""')}"."agent_run_skills_used"
                 (run_id, skill_id, skill_kind, invocation_count)
               VALUES ($1, $2, $3, 1)
               ON CONFLICT (run_id, skill_id)
               DO UPDATE SET invocation_count = "${schema.replaceAll('"', '""')}"."agent_run_skills_used".invocation_count + 1`,
        values: [input.runId, input.skillId, input.skillKind],
      },
    ],
  });
}

export function listSkillsUsedForRun(input: { runId: string }): AgentRunSkillUsed[] {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT id, run_id, skill_id, skill_kind, first_invoked_at, invocation_count
               FROM "${schema.replaceAll('"', '""')}"."agent_run_skills_used"
               WHERE run_id = $1
               ORDER BY invocation_count DESC, first_invoked_at ASC`,
        values: [input.runId],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    runId: String(r.run_id),
    skillId: String(r.skill_id),
    skillKind: String(r.skill_kind) as SkillKind,
    firstInvokedAt: String(r.first_invoked_at),
    invocationCount: Number(r.invocation_count ?? 0),
  }));
}
