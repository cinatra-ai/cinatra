/**
 * Skill efficacy read model + candidate computation (S10, cinatra#1368).
 *
 * Joins the per-skill exposure/invocation rollup (readSkillExposureAggregates
 * over agent_run_skills_used) with each skill's lifecycle metadata to produce
 * the skills-admin efficacy view and the DEPRECATION-CANDIDATE flag.
 *
 * A deprecation candidate is an EXPOSED-but-never-invoked skill over a minimum
 * sample — flagged for HUMAN review, never auto-deprecated:
 *   - lifecycleState === "active"  (only skills WITH a lifecycle can be
 *     deprecated; extension skills are DERIVED with NULL state and are excluded);
 *   - invocationCount === 0        (never invoked);
 *   - attributableExposureRunCount >= SKILL_DEPRECATION_MIN_EXPOSURE_SAMPLE —
 *     the minimum sample counts ONLY exposures via an invocation-attributable
 *     mode, so a skill exposed only through non-attributable modes (Gemini
 *     inline, Anthropic container, personal inline) can never be a candidate;
 *   - not dismissed (the human "reviewed — keep it" decision).
 *
 * State changes are HUMAN-confirmed: the positive decision is a lifecycle
 * transition to 'deprecated' (transitionSkillLifecycle, admin action); the
 * negative decision is dismissDeprecationCandidate() here.
 */
import "server-only";

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
import {
  readSkillExposureAggregates,
  type SkillExposureAggregate,
} from "@/lib/agent-run-skills-used";

/**
 * Minimum count of INVOCATION-ATTRIBUTABLE exposures (distinct runs) before an
 * exposed-but-never-invoked skill is flagged as a deprecation candidate. Keeps
 * a rarely-run-but-useful skill off the list until the sample is meaningful.
 */
export const SKILL_DEPRECATION_MIN_EXPOSURE_SAMPLE = 20;

export type SkillEfficacyRow = {
  skillId: string;
  name: string | null;
  /** 'draft' | 'active' | 'deprecated' | 'archived', or null for derived skills. */
  lifecycleState: string | null;
  exposureRunCount: number;
  attributableExposureRunCount: number;
  invocationCount: number;
  deliveryModes: string[];
  lastExposedAt: string | null;
  dismissedAt: string | null;
  /** Computed live — never persisted. See the module doc for the rule. */
  isDeprecationCandidate: boolean;
};

type SkillMeta = {
  name: string | null;
  lifecycleState: string | null;
  dismissedAt: string | null;
};

function readSkillMetaByIds(skillIds: string[]): Map<string, SkillMeta> {
  const meta = new Map<string, SkillMeta>();
  if (skillIds.length === 0) return meta;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."skills"`;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        // payload is a JSON text blob; pull only the display name out of it so
        // large skill bodies never cross the wire.
        text: `SELECT id,
                      lifecycle_state,
                      deprecation_candidate_dismissed_at,
                      (payload::jsonb ->> 'name') AS name
               FROM ${table}
               WHERE id = ANY($1)`,
        values: [skillIds],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  for (const r of rows) {
    meta.set(String(r.id), {
      name: r.name == null ? null : String(r.name),
      lifecycleState: r.lifecycle_state == null ? null : String(r.lifecycle_state),
      dismissedAt:
        r.deprecation_candidate_dismissed_at == null
          ? null
          : String(r.deprecation_candidate_dismissed_at),
    });
  }
  return meta;
}

/**
 * The pure deprecation-candidate rule (unit-tested independently of the DB).
 * True iff an ACTIVE, undismissed skill was exposed via an
 * invocation-attributable mode over at least the minimum sample yet was never
 * invoked. A skill exposed only via non-attributable modes has
 * attributableExposureRunCount === 0 and can therefore never qualify.
 */
export function isDeprecationCandidate(input: {
  lifecycleState: string | null;
  dismissedAt: string | null;
  invocationCount: number;
  attributableExposureRunCount: number;
}): boolean {
  return (
    input.lifecycleState === "active" &&
    input.dismissedAt == null &&
    input.invocationCount === 0 &&
    input.attributableExposureRunCount >= SKILL_DEPRECATION_MIN_EXPOSURE_SAMPLE
  );
}

function toRow(agg: SkillExposureAggregate, meta: SkillMeta | undefined): SkillEfficacyRow {
  const lifecycleState = meta?.lifecycleState ?? null;
  const dismissedAt = meta?.dismissedAt ?? null;
  const isDeprecationCandidateFlag = isDeprecationCandidate({
    lifecycleState,
    dismissedAt,
    invocationCount: agg.invocationCount,
    attributableExposureRunCount: agg.attributableExposureRunCount,
  });
  return {
    skillId: agg.skillId,
    name: meta?.name ?? null,
    lifecycleState,
    exposureRunCount: agg.exposureRunCount,
    attributableExposureRunCount: agg.attributableExposureRunCount,
    invocationCount: agg.invocationCount,
    deliveryModes: agg.deliveryModes,
    lastExposedAt: agg.lastExposedAt,
    dismissedAt,
    isDeprecationCandidate: isDeprecationCandidateFlag,
  };
}

/**
 * The full skills-admin efficacy view: one row per EXPOSED skill (from the
 * ledger rollup), enriched with lifecycle metadata + the live candidate flag.
 * Sorted candidates-first, then by exposure count desc, then skill id.
 */
export function readSkillEfficacy(): SkillEfficacyRow[] {
  const aggregates = readSkillExposureAggregates();
  const meta = readSkillMetaByIds(aggregates.map((a) => a.skillId));
  const rows = aggregates.map((a) => toRow(a, meta.get(a.skillId)));
  rows.sort((x, y) => {
    if (x.isDeprecationCandidate !== y.isDeprecationCandidate) {
      return x.isDeprecationCandidate ? -1 : 1;
    }
    if (x.exposureRunCount !== y.exposureRunCount) {
      return y.exposureRunCount - x.exposureRunCount;
    }
    return x.skillId < y.skillId ? -1 : x.skillId > y.skillId ? 1 : 0;
  });
  return rows;
}

/** Just the current deprecation candidates (for badges / counts). */
export function readDeprecationCandidates(): SkillEfficacyRow[] {
  return readSkillEfficacy().filter((r) => r.isDeprecationCandidate);
}

/**
 * The human "reviewed — keep it" decision: clear a skill from the candidate
 * list without deprecating it. Idempotent; scoped to skills that actually carry
 * a lifecycle (a derived skill has no candidacy to dismiss).
 */
export function dismissDeprecationCandidate(skillId: string): void {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."skills"`;
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `UPDATE ${table}
               SET deprecation_candidate_dismissed_at = now()
               WHERE id = $1 AND lifecycle_state IS NOT NULL`,
        values: [skillId],
      },
    ],
  });
}

/** Undo a dismissal — the skill re-enters candidacy if it still qualifies. */
export function reinstateDeprecationCandidate(skillId: string): void {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."skills"`;
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `UPDATE ${table}
               SET deprecation_candidate_dismissed_at = NULL
               WHERE id = $1`,
        values: [skillId],
      },
    ],
  });
}
