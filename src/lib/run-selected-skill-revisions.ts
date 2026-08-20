/**
 * run_selected_skill_revisions store — the AUTHORITATIVE per-run selected
 * skill-revision set (cinatra#2041, epic #2037 S3, Point R).
 *
 * S0 (cinatra#2038) landed the immutable table + the `SelectedSkillRevision`
 * contract; this is its access layer. The set is the ONE authoritative per-run
 * selection every delivery path consumes:
 *   - the execution-start snapshot materializes the run's skill ledger from it;
 *   - the llm-bridge delivers from it instead of recomputing when a set exists.
 * A confirmed/auto-applied set therefore changes what BOTH deliver; with NO set,
 * behavior is unchanged (each consumer falls back to today's computed
 * assignment). Distinct from the telemetry-only `agent_run_skills_used` ledger
 * (untouched — that stays exposure/invocation telemetry).
 *
 * IMMUTABILITY: a selection is written once per (run_id, skill_id) — the insert
 * is `ON CONFLICT (run_id, skill_id) DO NOTHING`, so a re-emit on resume can
 * never overwrite the pinned revision a run already committed to. The `id` PK is
 * generated here (S0's table carries `id text PRIMARY KEY`).
 *
 * Mirrors the sync-store shape of `agent-run-skills-used.ts` (server-only,
 * `runPostgresQueriesSync`) so the same run-scoped call sites (execution worker,
 * llm-bridge route) consume it with one import surface.
 */
import "server-only";

import { randomUUID } from "node:crypto";

import { SELECTION_SOURCES } from "@cinatra-ai/skills/recommendation";

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
import type { SelectionSource } from "@cinatra-ai/skills/recommendation";

export type { SelectionSource };

/** One persisted per-run selection row (mirrors `SelectedSkillRevision` from
 * `@/lib/lifecycle`, with the source narrowed to the S3 enum). */
export type RunSelectedSkillRevision = {
  id: string;
  runId: string;
  skillId: string;
  skillRevisionId: string;
  selectionSource: string;
  selectedAt: string;
};

/**
 * Persist the immutable per-run selection set. Idempotent on (run_id, skill_id):
 * a re-run (resume) never overwrites an existing pinned revision — first write
 * wins. No-op on an empty set. Best-effort by contract at the call site (a
 * selection-store write must never fail a run); this function itself throws only
 * on a genuine DB error, which the caller wraps.
 */
export function writeRunSelectedSkillRevisions(input: {
  runId: string;
  selections: Array<{
    skillId: string;
    skillRevisionId: string;
    selectionSource: SelectionSource | string;
  }>;
}): void {
  if (input.selections.length === 0) return;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."run_selected_skill_revisions"`;
  const valuesSql: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const s of input.selections) {
    valuesSql.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(
      randomUUID(),
      input.runId,
      s.skillId,
      s.skillRevisionId,
      s.selectionSource,
    );
  }
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO ${table}
                 (id, run_id, skill_id, skill_revision_id, selection_source)
               VALUES ${valuesSql.join(", ")}
               ON CONFLICT (run_id, skill_id) DO NOTHING`,
        values: params,
      },
    ],
  });
}

/**
 * Read the authoritative per-run selection set. Ordered by skill_id for a
 * stable, reproducible delivery order. Empty array ⇒ no set exists (the
 * consumer falls back to its computed assignment).
 */
export function readRunSelectedSkillRevisions(
  runId: string,
): RunSelectedSkillRevision[] {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT id, run_id, skill_id, skill_revision_id, selection_source, selected_at
               FROM "${schema.replaceAll('"', '""')}"."run_selected_skill_revisions"
               WHERE run_id = $1
               ORDER BY skill_id ASC`,
        values: [runId],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    runId: String(r.run_id),
    skillId: String(r.skill_id),
    skillRevisionId: String(r.skill_revision_id),
    selectionSource: String(r.selection_source),
    selectedAt: String(r.selected_at),
  }));
}

/**
 * Whether an authoritative selection set exists for a run — the guard every
 * delivery path checks before choosing set-vs-computed. A single EXISTS probe
 * (cheaper than reading the full set when the consumer only needs the boolean).
 */
export function hasRunSelectedSkillRevisions(runId: string): boolean {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT 1
               FROM "${schema.replaceAll('"', '""')}"."run_selected_skill_revisions"
               WHERE run_id = $1
               LIMIT 1`,
        values: [runId],
      },
    ],
  });
  return (result?.rows?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// The REJECTED half of the efficacy split (cinatra#2040 S2, routed from S3 AC-6).
//
// S3 computed accepted vs rejected in `summarizeRecommendationEfficacy` but only
// persisted the ACCEPTED selections (above); the REJECTED recommendations were
// dropped. S2 owns the durable rejected row (`run_rejected_recommendations`, the
// schema sibling of the batch-disposition table). It lives HERE — beside the
// accepted-half writer, both sync-pg — so the confirm path writes both halves
// through the SAME already-reachable module (no new first-party route-graph node,
// no coupling to the heavier repair store).
// ---------------------------------------------------------------------------

export type RunRejectedRecommendation = {
  skillId: string;
  skillRevisionId: string | null;
  recommendationSource: string;
  recommendedRank: number | null;
};

/**
 * Persist the REJECTED half of the recommendation efficacy split (the accepted
 * half rode `writeRunSelectedSkillRevisions`). Idempotent on (run_id, skill_id) —
 * first write wins. No-op on an empty set; best-effort at the call site (a
 * telemetry write must never fail a run).
 */
export function writeRunRejectedRecommendations(input: {
  runId: string;
  rejected: Array<{ skillId: string; skillRevisionId?: string | null; recommendationSource: string; recommendedRank?: number | null }>;
}): void {
  if (input.rejected.length === 0) return;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."run_rejected_recommendations"`;
  const valuesSql: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const r of input.rejected) {
    valuesSql.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(
      randomUUID(),
      input.runId,
      r.skillId,
      r.skillRevisionId ?? null,
      r.recommendationSource,
      r.recommendedRank ?? null,
    );
  }
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO ${table}
                 (id, run_id, skill_id, skill_revision_id, recommendation_source, recommended_rank)
               VALUES ${valuesSql.join(", ")}
               ON CONFLICT (run_id, skill_id) DO NOTHING`,
        values: params,
      },
    ],
  });
}

/**
 * The recommendation_source stamp a DURABLE SKIP writes (cinatra#2067 item 4).
 * A human who SKIPS the run-start chip-row makes an explicit decision — "use the
 * computed default set" — that must be distinguishable from "no decision" (no
 * rows) AND from a confirm (which writes selection rows + `recommended_not_kept`
 * rejected rows). A skip writes NO selection row (the run falls back to the
 * computed default) and one `user_skipped` rejected row per recommended
 * candidate — the durable, queryable skip evidence.
 */
export const SKIP_RECOMMENDATION_SOURCE = "user_skipped" as const;

/**
 * Whether a run carries durable SKIP evidence (at least one `user_skipped`
 * rejected-recommendation row). Distinguishes an explicit skip from a no-decision
 * run (issue #2067 AC-3 store evidence).
 */
export function hasRunRecommendationSkip(runId: string): boolean {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT 1
               FROM "${schema.replaceAll('"', '""')}"."run_rejected_recommendations"
               WHERE run_id = $1 AND recommendation_source = $2
               LIMIT 1`,
        values: [runId, SKIP_RECOMMENDATION_SOURCE],
      },
    ],
  });
  return (result?.rows?.length ?? 0) > 0;
}

/** Read the durable rejected-recommendation rows for a run (ordered by skill_id). */
export function readRunRejectedRecommendations(runId: string): RunRejectedRecommendation[] {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT skill_id, skill_revision_id, recommendation_source, recommended_rank
               FROM "${schema.replaceAll('"', '""')}"."run_rejected_recommendations"
               WHERE run_id = $1
               ORDER BY skill_id ASC`,
        values: [runId],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    skillId: String(r.skill_id),
    skillRevisionId: r.skill_revision_id == null ? null : String(r.skill_revision_id),
    recommendationSource: String(r.recommendation_source),
    recommendedRank: r.recommended_rank == null ? null : Number(r.recommended_rank),
  }));
}

/**
 * What ONE chip recorded, for the SETTLED reading the ratified drawing fixes
 * (design `specs/app-lifecycle-cards.html` §V at 60b27dfbb8a2: "one chip per
 * skill, each showing what it recorded"). Derived from the run's OWN durable
 * evidence — nothing new is written to represent it:
 *
 *   confirmed — a selection row whose source is `recommended_confirmed`
 *               (the reader took the skill as scored);
 *   adjusted  — a selection row whose source is `user_forced` (the reader
 *               edited that skill's selection onto the run);
 *   skipped   — a rejected-recommendation row (`recommended_not_kept` from a
 *               confirm that left it out, or `user_skipped` from a skip).
 */
export type RunRecommendationDecidedSkill = {
  skillId: string;
  mark: "confirmed" | "adjusted" | "skipped";
};

/**
 * Build §V's settled per-chip reading out of the two durable halves the run
 * already writes. A selection row wins over a rejected row for the same skill
 * (a skill that is IN the run's authoritative set was kept, whatever else was
 * recorded on the way), and the order is by skill id so the settled row is
 * stable across reads.
 */
export function decidedSkillsFromEvidence(
  selected: Pick<RunSelectedSkillRevision, "skillId" | "selectionSource">[],
  rejected: Pick<RunRejectedRecommendation, "skillId">[],
): RunRecommendationDecidedSkill[] {
  const marks = new Map<string, RunRecommendationDecidedSkill["mark"]>();
  for (const row of selected) {
    marks.set(
      row.skillId,
      row.selectionSource === SELECTION_SOURCES.userForced ? "adjusted" : "confirmed",
    );
  }
  for (const row of rejected) {
    if (!marks.has(row.skillId)) marks.set(row.skillId, "skipped");
  }
  return [...marks.entries()]
    .map(([skillId, mark]) => ({ skillId, mark }))
    .sort((a, b) => (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0));
}
