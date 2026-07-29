/**
 * agent_run_skills_used ledger access.
 *
 * Per-run snapshot of which skills were resolved, exposed, and invoked during a
 * run — the persistence layer for the S10 efficacy loop (cinatra#1368).
 *
 * Write paths:
 *   - Snapshot at run start: snapshotSkillsAtRunStart() inserts the resolved
 *     org/shared skill set (from getAssignedSkillIdsForAgent) with
 *     invocation_count=0 and delivery_mode/invocation_attributable left NULL
 *     (mode is not yet known at the sessionless run-start seam — it resolves at
 *     the per-step llm-bridge boundary). Idempotent on (run_id, skill_id).
 *     Called once per dispatch by the agent-execution worker
 *     (packages/agents/src/execution.ts).
 *   - Exposure at the delivery boundary: recordSkillExposure() upserts one row
 *     per skill the model was actually exposed to on an LLM step — INCLUDING
 *     personal deltas (which the run-start snapshot intentionally omits, having
 *     no verified owner) — stamping the delivery_mode + invocation_attributable
 *     the provider adapter reported (llm-bridge, cinatra#1368). Never resets
 *     invocation_count.
 *   - Increment on invocation: incrementSkillInvocation() upserts +
 *     increments invocation_count at the attributable skill-use boundary (an
 *     OpenAI shell read of a named /skills/<slug> file — the only delivery mode
 *     that surfaces a per-skill signal). Non-attributable modes (Gemini inline,
 *     Anthropic container, personal inline) never call it; their counts stay 0,
 *     which is why they can never become deprecation candidates.
 *
 * Read paths:
 *   - listSkillsUsedForRun() — Skills tab in the agent run detail page.
 *   - readSkillExposureAggregates() — per-skill exposure/invocation rollup for
 *     the skills-admin efficacy view + deprecation-candidate computation.
 */
import "server-only";

import type { SkillDeliveryMode } from "@cinatra-ai/llm";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";

export type { SkillDeliveryMode };

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
  /**
   * The mode the invocation was observed through. Attributable invocations come
   * only from the OpenAI shell path today, so this defaults to "openai_shell".
   * Stamped on both the insert and the conflicting row so an invoked skill's
   * mode is always recorded.
   */
  deliveryMode?: SkillDeliveryMode;
}): void {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."agent_run_skills_used"`;
  const deliveryMode = input.deliveryMode ?? "openai_shell";
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        // An invocation is, by construction, an attributable event —
        // invocation_attributable=true on both insert and update.
        text: `INSERT INTO ${table}
                 (run_id, skill_id, skill_kind, invocation_count, delivery_mode, invocation_attributable)
               VALUES ($1, $2, $3, 1, $4, true)
               ON CONFLICT (run_id, skill_id)
               DO UPDATE SET
                 invocation_count = ${table}.invocation_count + 1,
                 delivery_mode = COALESCE(${table}.delivery_mode, EXCLUDED.delivery_mode),
                 invocation_attributable = true`,
        values: [input.runId, input.skillId, input.skillKind, deliveryMode],
      },
    ],
  });
}

/**
 * Record one exposure event per skill the model was actually delivered on an
 * LLM step — INCLUDING personal deltas (which the run-start snapshot omits).
 * Upserts on (run_id, skill_id): a fresh exposure inserts with
 * invocation_count=0; an existing row (e.g. the run-start snapshot, or a prior
 * step) keeps its invocation_count and is stamped with the resolved
 * delivery_mode + invocation_attributable. Best-effort, idempotent, and must
 * never fail a run (the caller wraps it).
 */
export function recordSkillExposure(input: {
  runId: string;
  exposures: Array<{
    skillId: string;
    skillKind: SkillKind;
    deliveryMode: SkillDeliveryMode;
    invocationAttributable: boolean;
  }>;
}): void {
  if (input.exposures.length === 0) return;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."agent_run_skills_used"`;
  const valuesSql: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const e of input.exposures) {
    valuesSql.push(`($${p++}, $${p++}, $${p++}, 0, $${p++}, $${p++})`);
    params.push(
      input.runId,
      e.skillId,
      e.skillKind,
      e.deliveryMode,
      e.invocationAttributable,
    );
  }
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO ${table}
                 (run_id, skill_id, skill_kind, invocation_count, delivery_mode, invocation_attributable)
               VALUES ${valuesSql.join(", ")}
               ON CONFLICT (run_id, skill_id)
               DO UPDATE SET
                 delivery_mode = EXCLUDED.delivery_mode,
                 -- invocation_attributable is MONOTONIC (sticky-true): once a
                 -- skill has been exposed via an attributable mode in a run, a
                 -- later non-attributable exposure of the same (run, skill) —
                 -- e.g. a mixed-provider run, or an exposure landing after
                 -- incrementSkillInvocation already set it true — must NOT flip
                 -- it back to false, which would undercount the attributable
                 -- sample and hide a legitimate candidate. NULL (snapshot) reads
                 -- as false for the OR.
                 invocation_attributable =
                   COALESCE(${table}.invocation_attributable, false)
                   OR EXCLUDED.invocation_attributable,
                 -- cinatra#2091 S4: a real exposure supersedes any earlier
                 -- injection DROP marker for the same (run, skill) — the skill
                 -- did reach the model on this step.
                 injection_drop_reason = NULL`,
        values: params,
      },
    ],
  });
}

/**
 * Record skills the typed injection contract RESOLVED but did NOT deliver
 * (cinatra#2091, epic #2086 S4) — cap truncation and inline-budget overflow.
 *
 * A dropped skill never reached the model, so it gets NO delivery mode and NO
 * attributability; it is stamped with `injection_drop_reason` on the same
 * ledger row so the efficacy surface can distinguish "never delivered" from
 * "delivered and never invoked". `DO UPDATE` deliberately does NOT overwrite a
 * row that already carries a delivery mode: within one run a skill may be
 * dropped on one step and delivered on another, and the delivery is the
 * stronger fact.
 *
 * Best-effort and idempotent, exactly like the exposure writer — the caller
 * wraps it and a ledger write must never fail a run.
 */
export function recordSkillInjectionDrops(input: {
  runId: string;
  drops: Array<{ skillId: string; skillKind: SkillKind; reason: string }>;
}): void {
  if (input.drops.length === 0) return;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."agent_run_skills_used"`;
  const valuesSql: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const d of input.drops) {
    valuesSql.push(`($${p++}, $${p++}, $${p++}, 0, $${p++})`);
    params.push(input.runId, d.skillId, d.skillKind, d.reason);
  }
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO ${table}
                 (run_id, skill_id, skill_kind, invocation_count, injection_drop_reason)
               VALUES ${valuesSql.join(", ")}
               ON CONFLICT (run_id, skill_id)
               DO UPDATE SET
                 injection_drop_reason =
                   CASE WHEN ${table}.delivery_mode IS NULL
                        THEN EXCLUDED.injection_drop_reason
                        ELSE ${table}.injection_drop_reason
                   END`,
        values: params,
      },
    ],
  });
}

/**
 * Per-skill exposure/invocation rollup across all runs, for the skills-admin
 * efficacy view and deprecation-candidate computation.
 *   - exposureRunCount: distinct runs the skill was exposed in (any mode).
 *   - attributableExposureRunCount: distinct runs the skill was exposed in via
 *     an INVOCATION-ATTRIBUTABLE mode (invocation_attributable=true). Only these
 *     count toward the minimum sample — a skill exposed only via
 *     non-attributable modes can never be a candidate.
 *   - invocationCount: total invocations across all runs.
 *   - lastExposedAt: most recent exposure (first_invoked_at proxy).
 *   - deliveryModes: distinct non-null modes observed, ascending.
 */
export type SkillExposureAggregate = {
  skillId: string;
  exposureRunCount: number;
  attributableExposureRunCount: number;
  invocationCount: number;
  lastExposedAt: string | null;
  deliveryModes: string[];
};

export function readSkillExposureAggregates(): SkillExposureAggregate[] {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."agent_run_skills_used"`;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT
                 skill_id,
                 COUNT(DISTINCT run_id) AS exposure_run_count,
                 COUNT(DISTINCT run_id) FILTER (WHERE invocation_attributable IS TRUE) AS attributable_exposure_run_count,
                 COALESCE(SUM(invocation_count), 0) AS invocation_count,
                 MAX(first_invoked_at) AS last_exposed_at,
                 COALESCE(
                   ARRAY_AGG(DISTINCT delivery_mode) FILTER (WHERE delivery_mode IS NOT NULL),
                   '{}'
                 ) AS delivery_modes
               FROM ${table}
               GROUP BY skill_id`,
        values: [],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    skillId: String(r.skill_id),
    exposureRunCount: Number(r.exposure_run_count ?? 0),
    attributableExposureRunCount: Number(r.attributable_exposure_run_count ?? 0),
    invocationCount: Number(r.invocation_count ?? 0),
    lastExposedAt: r.last_exposed_at == null ? null : String(r.last_exposed_at),
    deliveryModes: Array.isArray(r.delivery_modes)
      ? (r.delivery_modes as unknown[]).map((m) => String(m))
      : [],
  }));
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
