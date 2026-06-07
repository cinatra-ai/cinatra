import "server-only";

/**
 * Production drift sampler.
 *
 * BullMQ job handler that re-evaluates a small random sample of
 * `skill_matches` rows per run and emits a structured `skill-match-drift`
 * log event when the new decision differs from the persisted decision OR
 * the score shifts by more than the delta threshold.
 *
 * --- Why this matters --------------------------------------------------------
 *
 * `gpt-4o-mini` semantics shift between OpenAI's provider-side updates
 * (model snapshots are deprecated periodically; subtle prompt-interaction
 * changes can silently re-route hundreds of skills). Today there is no
 * signal that this has happened — admin has to manually click
 * "Re-evaluate all" to discover drift. The sampler is the production
 * canary that catches this between admin cycles.
 *
 * --- Why the catalog provider seam ------------------------------------------
 *
 * Re-evaluating a row requires re-rendering the full prompt (the SKILL.md
 * content, the agent description). The store row only carries the FK ids
 * and the previous decision — not the live source content. The catalog
 * provider seam lets this module reach the host's catalog
 * (`readAgents` / `getSkillById`) WITHOUT pulling `@/lib/agents-store`
 * into `@cinatra-ai/skills` and re-introducing the circular dependency.
 *
 * --- Why disabled by default ------------------------------------------------
 *
 * The sampler is a real LLM call (one per sampled row, 5/day default) and so
 * carries a small recurring cost. Enabling it requires explicit opt-in via the
 * `skill_match_schedule.drift_sampler_enabled` row column. The job handler
 * and boot-time scheduler registration keep the foundations in place for the
 * enable toggle.
 */

import { evaluatePair } from "./evaluate-pair";
import { adaptAgentForMatching, adaptSkillForMatching } from "./adapters";
import {
  SKILL_MATCH_DRIFT_SAMPLE_SIZE,
  SKILL_MATCH_DRIFT_SCORE_DELTA_THRESHOLD,
  LLM_MATCHER_VERSION,
} from "./constants";
import type {
  AgentForMatching,
  CatalogProvider,
  SkillForMatching,
  SkillMatchRow,
} from "./types";
import * as defaultStore from "./skill-matches-store";

export type DriftSampleRowDiff = {
  agentId: string;
  skillId: string;
  /** Previous LLM decision (the row already persisted in `skill_matches`). */
  previous: { matched: boolean; score: number; evaluatorVersion: string };
  /** Current LLM decision (just produced by re-evaluating the pair). */
  current: { matched: boolean; score: number; evaluatorVersion: string };
  /** Absolute difference of the two scores (NaN-safe; score=null treated as 0). */
  scoreDelta: number;
  /** True when matched flipped between previous and current. */
  decisionFlipped: boolean;
  /** True when |scoreDelta| exceeds the configured threshold. */
  scoreDeltaAboveThreshold: boolean;
};

export type DriftSampleResult = {
  sampledCount: number;
  evaluatedCount: number;
  /** Per-row diff for every row that was re-evaluated. */
  diffs: DriftSampleRowDiff[];
  /** Number of rows where decision flipped OR score moved beyond threshold. */
  driftCount: number;
};

export type DriftSampleDeps = {
  catalog: CatalogProvider;
  /** Test override for the sample reader. Defaults to the production store. */
  readRandomLlmOkMatches?: (sampleSize: number) => Promise<SkillMatchRow[]>;
  /** Test override for evaluatePair (mocks the LLM round-trip). */
  evaluate?: typeof evaluatePair;
  /** Test override for clock (deterministic timestamps in unit tests). */
  now?: () => Date;
  /** Test override for the sample size constant. */
  sampleSize?: number;
};

/**
 * Coerce a possibly-null score into a number for delta math. Manual rows
 * carry `score = null` (CHECK constraint), but the sampler filters those
 * out (`source = 'llm'`); guard anyway so a future schema change cannot
 * NaN-poison the delta.
 */
function scoreOrZero(score: number | null): number {
  if (score === null || Number.isNaN(score)) return 0;
  return score;
}

/**
 * Compute the diff between a persisted `previous` row and a freshly produced
 * `current` row. Pure function — easy to unit-test independently.
 */
function buildDiff(previous: SkillMatchRow, current: SkillMatchRow): DriftSampleRowDiff {
  const previousScore = scoreOrZero(previous.score);
  const currentScore = scoreOrZero(current.score);
  const scoreDelta = Math.abs(currentScore - previousScore);
  const decisionFlipped = previous.matched !== current.matched;
  const scoreDeltaAboveThreshold = scoreDelta > SKILL_MATCH_DRIFT_SCORE_DELTA_THRESHOLD;
  return {
    agentId: previous.agentId,
    skillId: previous.skillId,
    previous: {
      matched: previous.matched,
      score: previousScore,
      evaluatorVersion: previous.evaluatorVersion,
    },
    current: {
      matched: current.matched,
      score: currentScore,
      evaluatorVersion: current.evaluatorVersion,
    },
    scoreDelta,
    decisionFlipped,
    scoreDeltaAboveThreshold,
  };
}

/**
 * Resolve a persisted match row's (agentId, skillId) back to the live
 * AgentForMatching / SkillForMatching shapes that `evaluatePair` needs. When
 * the agent or skill has been uninstalled since the row was written, returns
 * `null` so the caller can skip without polluting the diff list.
 */
async function resolvePair(
  row: SkillMatchRow,
  catalog: CatalogProvider,
): Promise<{ agent: AgentForMatching; skill: SkillForMatching } | null> {
  const [agents, skill] = await Promise.all([
    catalog.readAgents(),
    catalog.getSkillById(row.skillId),
  ]);
  if (!skill) return null;
  const agent = agents.find((a) => a.packageId === row.agentId);
  if (!agent) return null;
  return {
    agent: adaptAgentForMatching(agent),
    skill: adaptSkillForMatching({
      id: skill.id,
      name: skill.name,
      level: skill.level,
      content: skill.content ?? "",
      agentId: undefined,
    }),
  };
}

/**
 * Execute one drift-sample run.
 *
 * Test surface: pass an inline `deps.readRandomLlmOkMatches` + `deps.evaluate`
 * to drive the handler without a real DB or OpenAI call. Unit tests use this
 * seam (no Postgres, no LLM); the production wiring in
 * `src/lib/background-jobs.ts` injects only `deps.catalog` and lets the
 * defaults reach the real store + the real evaluator.
 */
export async function handleDriftSample(deps: DriftSampleDeps): Promise<DriftSampleResult> {
  const readRandomLlmOkMatches =
    deps.readRandomLlmOkMatches ?? defaultStore.readRandomLlmOkMatches;
  const evaluate = deps.evaluate ?? evaluatePair;
  const sampleSize = deps.sampleSize ?? SKILL_MATCH_DRIFT_SAMPLE_SIZE;
  const now = deps.now ?? (() => new Date());

  const sample = await readRandomLlmOkMatches(sampleSize);
  const sampledCount = sample.length;

  const diffs: DriftSampleRowDiff[] = [];
  let evaluatedCount = 0;

  for (const row of sample) {
    const pair = await resolvePair(row, deps.catalog);
    if (!pair) continue; // agent or skill uninstalled — silently skip.

    // Anchor jobStartedAt at the start of THIS evaluation so the sampler's
    // re-write does not collide with an in-flight inline write under the
    // stale-write guard. The sampler is allowed to overwrite older rows (its
    // purpose is to refresh the decision) but not newer ones.
    const jobStartedAt = now();

    let result;
    try {
      result = await evaluate(
        { agent: pair.agent, skill: pair.skill },
        { now, jobStartedAt },
      );
    } catch (err) {
      console.warn(
        `[skill-match] drift-sampler evaluation failed for ${pair.agent.packageId} × ${pair.skill.skillId}:`,
        err,
      );
      continue;
    }

    const currentRow = result.row;
    if (!currentRow) continue; // upsert was a no-op (manual-protected row).

    evaluatedCount += 1;

    // Synthesize a SkillMatchRow shape for the diff (the upsert result drops
    // evaluatedAt/jobStartedAt, but the diff doesn't read them).
    const currentForDiff: SkillMatchRow = {
      ...currentRow,
      evaluatedAt: jobStartedAt,
      jobStartedAt,
    };

    diffs.push(buildDiff(row, currentForDiff));
  }

  // Emit a structured `skill-match-drift` event for each diff when the
  // decision flipped OR the score delta exceeds the threshold. We use
  // console.warn with a JSON.stringify payload (matches the existing
  // `skill_match_inline_pairs_dropped` pattern in jobs.ts) so the events show
  // up in the same log-scrape pipeline that surfaces the inline-cap drops.
  //
  // Event kind precedence: when BOTH a flip AND a score-delta breach happen,
  // we emit a single event with kind="decision-flip" (the flip is strictly
  // more severe — it changes which agents are matched to which skills, which
  // is what production callers care about). The scoreDelta is still included
  // in the payload so a single event captures both signals.
  let driftCount = 0;
  for (const diff of diffs) {
    if (!diff.decisionFlipped && !diff.scoreDeltaAboveThreshold) continue;
    driftCount += 1;
    const kind: "decision-flip" | "score-delta" = diff.decisionFlipped
      ? "decision-flip"
      : "score-delta";
    console.warn(
      JSON.stringify({
        event: "skill-match-drift",
        kind,
        agentId: diff.agentId,
        skillId: diff.skillId,
        evaluatorVersion: {
          from: diff.previous.evaluatorVersion,
          to: diff.current.evaluatorVersion,
        },
        previous: { matched: diff.previous.matched, score: diff.previous.score },
        current: { matched: diff.current.matched, score: diff.current.score },
        scoreDelta: diff.scoreDelta,
      }),
    );
  }

  void LLM_MATCHER_VERSION; // Imported for future evaluator-version diff plumbing.

  return {
    sampledCount,
    evaluatedCount,
    diffs,
    driftCount,
  };
}
