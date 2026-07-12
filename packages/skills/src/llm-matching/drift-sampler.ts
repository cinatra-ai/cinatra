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
import { computeInputHashes } from "./hashes";
import {
  SKILL_MATCH_DRIFT_SAMPLE_SIZE,
  SKILL_MATCH_DRIFT_SCORE_DELTA_THRESHOLD,
  LLM_MATCHER_VERSION,
  RULE_MATCHER_VERSION,
  MANUAL_VERSION,
  SKILL_MATCH_ORPHAN_GC_GRACE_MS,
  SKILL_MATCH_DRIFT_FLAG_THRESHOLD,
} from "./constants";
import type {
  AgentForMatching,
  CatalogProvider,
  DriftObservationInput,
  DriftFlagMap,
  OrphanTombstoneMap,
  SkillForMatching,
  SkillMatchRow,
} from "./types";
import * as defaultStore from "./skill-matches-store";
// The maintenance KV (orphan tombstones / drift flags / manual-stale) is stored
// as plain connector_config blobs — colocated here (not in the size-ratcheted
// src/lib/database.ts) via the same host connector-config helpers skill-matches
// -store already uses for the DB connection string.
import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";

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
  /**
   * Optional durable drift-flag recorder (maintenance/#1365). When provided,
   * every re-evaluated pair's drift observation is persisted so repeatedly
   * drifting pairs are auto-flagged for the admin surface. Omitted by unit
   * tests that only assert the in-memory sampler result, so the existing
   * sampler behavior is unchanged when it is absent.
   */
  recordDriftObservations?: (observations: DriftObservationInput[]) => Promise<void>;
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
  const observations: DriftObservationInput[] = [];
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

    const diff = buildDiff(row, currentForDiff);
    diffs.push(diff);
    // Carry the CURRENT fingerprint (hashes + evaluator version) so the
    // drift-flag recorder keys/resets its cumulative counter per fingerprint.
    observations.push({
      agentId: diff.agentId,
      skillId: diff.skillId,
      isDrift: diff.decisionFlipped || diff.scoreDeltaAboveThreshold,
      kind: diff.decisionFlipped
        ? "decision-flip"
        : diff.scoreDeltaAboveThreshold
          ? "score-delta"
          : null,
      scoreDelta: diff.scoreDelta,
      agentInputHash: currentRow.agentInputHash,
      skillInputHash: currentRow.skillInputHash,
      evaluatorVersion: currentRow.evaluatorVersion,
    });
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

  // Persist per-pair drift observations when a recorder is wired (production).
  // Best-effort: a KV write failure must not fail the sampler run.
  if (deps.recordDriftObservations && observations.length > 0) {
    try {
      await deps.recordDriftObservations(observations);
    } catch (err) {
      console.warn("[skill-match] drift-flag recording failed:", err);
    }
  }

  return {
    sampledCount,
    evaluatedCount,
    diffs,
    driftCount,
  };
}

// ===========================================================================
// Matching maintenance (cinatra #1365 / S7): hash staleness sweep, tombstoned
// orphan GC, and drift-flag recording. Colocated with the drift sampler above
// because they share the match-store maintenance domain (and its imports).
// ===========================================================================

// ---------------------------------------------------------------------------
// Pair key
// ---------------------------------------------------------------------------

/**
 * NULL-byte-separated (agentId, skillId) key for the tombstone / drift-flag
 * maps. The null byte cannot appear in a valid id (Postgres text columns
 * reject 0x00), so there is no separator ambiguity even though skill ids may
 * contain spaces, `:` / `@` / `/`.
 */
const PAIR_KEY_SEP = String.fromCharCode(0);

export function pairKey(agentId: string, skillId: string): string {
  return `${agentId}${PAIR_KEY_SEP}${skillId}`;
}

export function parsePairKey(key: string): { agentId: string; skillId: string } {
  const idx = key.indexOf(PAIR_KEY_SEP);
  if (idx < 0) return { agentId: key, skillId: "" };
  return { agentId: key.slice(0, idx), skillId: key.slice(idx + 1) };
}

// ===========================================================================
// 1. Staleness sweep
// ===========================================================================

export type StaleSweepResult = {
  /** Rows examined. */
  scanned: number;
  /** Non-manual rows whose fingerprint / evaluator version was stale. */
  stale: number;
  /** Stale non-manual rows re-evaluated with a non-skipped upsert. */
  reevaluated: number;
  /** Re-evals capped for this tick (still stale; picked up next tick). */
  deferredOverCap: number;
  /** Manual rows whose inputs changed — flagged, never re-evaluated. */
  manualFlagged: number;
  /** Rows whose agent or skill is not in the live catalog (left to the GC). */
  absent: number;
  /** Re-evals that threw. */
  errors: number;
};

export type SweepDeps = {
  catalog: CatalogProvider;
  /** Test override for the full-row reader. Defaults to the production store. */
  readAllRows?: () => Promise<SkillMatchRow[]>;
  /** Test override for evaluatePair (mocks the LLM round-trip). */
  evaluate?: typeof evaluatePair;
  /** Injected clock for deterministic timestamps. */
  now?: () => Date;
  /**
   * Persist the set of manual (agent, skill) pairs whose inputs changed, for
   * the admin "inputs changed" surface. Replace semantics: pairs no longer
   * stale are cleared. Optional (omitted in unit tests that assert the result).
   */
  recordManualStale?: (pairs: { agentId: string; skillId: string }[]) => Promise<void>;
  /**
   * Max non-manual re-evaluations per tick. Bounds inline LLM cost when a
   * matcher-version bump makes a whole tier stale at once; the remainder stays
   * stale and is swept on the next tick (a stable sort guarantees forward
   * progress). Defaults to SKILL_MATCH_MAINTENANCE_SWEEP_MAX_REEVALS.
   */
  maxReevals?: number;
};

/** Default per-tick re-eval cap; see SweepDeps.maxReevals. */
export const SKILL_MATCH_MAINTENANCE_SWEEP_MAX_REEVALS = 200;

/** Stable comparator so the per-tick cap advances deterministically. */
function byPair(a: SkillMatchRow, b: SkillMatchRow): number {
  return a.agentId.localeCompare(b.agentId) || a.skillId.localeCompare(b.skillId);
}

export async function sweepStaleMatches(deps: SweepDeps): Promise<StaleSweepResult> {
  const now = deps.now ?? (() => new Date());
  const readAllRows = deps.readAllRows ?? defaultStore.readAllRows;
  const evaluate = deps.evaluate ?? evaluatePair;
  const maxReevals = deps.maxReevals ?? SKILL_MATCH_MAINTENANCE_SWEEP_MAX_REEVALS;

  // One anchor for every guarded upsert this run (see "single upsert anchor").
  const sweepStartedAt = now();

  // Fail closed: a read error here must throw, never resolve to [] (an empty
  // view would report nothing stale AND, in the GC, delete the whole catalog).
  const rows = (await readAllRows()).slice().sort(byPair);
  const [agents, skills] = await Promise.all([
    deps.catalog.readAgents(),
    deps.catalog.listSkills(),
  ]);
  const agentByPackageId = new Map(agents.map((a) => [a.packageId, a]));
  const skillById = new Map(skills.map((s) => [s.id, s]));

  const result: StaleSweepResult = {
    scanned: rows.length,
    stale: 0,
    reevaluated: 0,
    deferredOverCap: 0,
    manualFlagged: 0,
    absent: 0,
    errors: 0,
  };
  const manualStale: { agentId: string; skillId: string }[] = [];
  // The cap bounds the number of re-eval ATTEMPTS (each is a real LLM call and
  // therefore a cost), not just the non-skipped upserts — a skipped upsert
  // still paid for the evaluation. Counting attempts keeps a matcher-version
  // bump from firing an unbounded number of LLM calls in a single tick.
  let attempted = 0;

  for (const row of rows) {
    const agent = agentByPackageId.get(row.agentId);
    const skill = skillById.get(row.skillId);
    if (!agent || !skill) {
      result.absent += 1; // pair gone from the catalog — the GC handles it.
      continue;
    }

    const adaptedAgent = adaptAgentForMatching(agent);
    const adaptedSkill = adaptSkillForMatching({
      id: skill.id,
      name: skill.name,
      level: skill.level,
      content: skill.content ?? "",
      agentId: undefined,
    });
    const { agentInputHash, skillInputHash } = computeInputHashes(adaptedAgent, adaptedSkill);
    const hashMismatch =
      row.agentInputHash !== agentInputHash || row.skillInputHash !== skillInputHash;
    const expectedVersion =
      row.source === "llm"
        ? LLM_MATCHER_VERSION
        : row.source === "rule"
          ? RULE_MATCHER_VERSION
          : MANUAL_VERSION;
    const versionStale = row.source !== "manual" && row.evaluatorVersion !== expectedVersion;
    if (!hashMismatch && !versionStale) continue;

    if (row.source === "manual") {
      // Never machine-re-evaluate a manual pin. Flag "inputs changed" for the
      // admin surface; the operator decides whether to re-pin. (Version drift
      // on a manual row is not meaningful — it always carries MANUAL_VERSION.)
      if (hashMismatch) {
        result.manualFlagged += 1;
        manualStale.push({ agentId: row.agentId, skillId: row.skillId });
      }
      continue;
    }

    result.stale += 1;
    if (attempted >= maxReevals) {
      result.deferredOverCap += 1;
      continue;
    }
    attempted += 1;
    try {
      const res = await evaluate(
        { agent: adaptedAgent, skill: adaptedSkill },
        { now, jobStartedAt: sweepStartedAt },
      );
      if (!res.skipped) result.reevaluated += 1;
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[skill-match] maintenance sweep re-eval failed for ${row.agentId} × ${row.skillId}:`,
        err,
      );
    }
  }

  // Replace-semantics write of the manual-stale set (clears pairs that are no
  // longer stale). Best-effort: a KV write failure must not fail the sweep.
  if (deps.recordManualStale) {
    await deps.recordManualStale(manualStale).catch((err) => {
      console.warn("[skill-match] maintenance manual-stale write failed:", err);
    });
  }

  console.info(JSON.stringify({ event: "skill_match_maintenance_sweep", ...result }));
  return result;
}

// ===========================================================================
// 2. Tombstoned orphan GC
// ===========================================================================

export type OrphanGcResult = {
  scanned: number;
  /** Rows whose pair is live (any stale tombstone cleared). */
  live: number;
  /** Pairs observed absent for the first time — tombstoned, not deleted. */
  newlyTombstoned: number;
  /** Rows deleted (durably absent past the grace window). */
  deleted: number;
  /** Just-deleted pairs that had reappeared mid-run — a fresh eval re-enqueued. */
  reenqueuedAfterRace: number;
  /** Stale tombstones dropped because the pair came back. */
  clearedTombstones: number;
};

export type OrphanGcDeps = {
  catalog: CatalogProvider;
  readAllRows?: () => Promise<SkillMatchRow[]>;
  /** Conditional compare-and-delete. Defaults to the production store. */
  deleteOrphanRowIfStale?: (
    agentId: string,
    skillId: string,
    notRewrittenSinceIso: string,
  ) => Promise<number>;
  readTombstones: () => Promise<OrphanTombstoneMap>;
  writeTombstones: (map: OrphanTombstoneMap) => Promise<void>;
  /** Re-enqueue an inline eval for a pair that reappeared after a delete. */
  enqueueReeval?: (agentId: string, skillId: string) => Promise<void>;
  /** Prune drift flags for pairs that were deleted. */
  clearDriftFlags?: (pairKeys: string[]) => Promise<void>;
  graceMs?: number;
  now?: () => Date;
};

/**
 * Pure planner. Given the current rows, the live-id sets, and the existing
 * tombstones, decide which pairs to tombstone, delete, or clear — never
 * mutating anything. Deterministic and trivially unit-testable with an
 * injected clock.
 */
export function planOrphanGc(
  rows: Pick<SkillMatchRow, "agentId" | "skillId">[],
  liveAgentIds: Set<string>,
  liveSkillIds: Set<string>,
  tombstones: OrphanTombstoneMap,
  graceMs: number,
  now: Date,
): {
  tombstonesNext: OrphanTombstoneMap;
  toDelete: { agentId: string; skillId: string; notRewrittenSinceIso: string }[];
  clearedKeys: string[];
  newlyTombstonedKeys: string[];
  liveCount: number;
} {
  const tombstonesNext: OrphanTombstoneMap = {};
  const toDelete: { agentId: string; skillId: string; notRewrittenSinceIso: string }[] = [];
  const clearedKeys: string[] = [];
  const newlyTombstonedKeys: string[] = [];
  let liveCount = 0;
  // "Not rewritten since" == now - grace. The conditional delete removes a row
  // only if its evaluated_at is at or before this, so a reinstall re-evaluated
  // inside the window is never deleted (closes the delete-vs-reinstall TOCTOU).
  const notRewrittenSinceIso = new Date(now.getTime() - graceMs).toISOString();

  const seen = new Set<string>();
  for (const row of rows) {
    const key = pairKey(row.agentId, row.skillId);
    if (seen.has(key)) continue; // PK is (agent_id, skill_id); dedup defensively.
    seen.add(key);

    const live = liveAgentIds.has(row.agentId) && liveSkillIds.has(row.skillId);
    if (live) {
      liveCount += 1;
      if (tombstones[key]) clearedKeys.push(key); // pair came back — drop tombstone.
      continue;
    }

    const existing = tombstones[key];
    if (!existing) {
      // First observed absence — record, NEVER delete on one snapshot.
      tombstonesNext[key] = {
        agentId: row.agentId,
        skillId: row.skillId,
        firstAbsentAt: now.toISOString(),
      };
      newlyTombstonedKeys.push(key);
      continue;
    }

    const firstAbsentAt = Date.parse(existing.firstAbsentAt);
    const graceExpired =
      Number.isFinite(firstAbsentAt) && now.getTime() - firstAbsentAt >= graceMs;
    if (graceExpired) {
      // Attempt deletion. Do not carry the tombstone forward: a successful
      // delete removes the row; a no-op delete (reinstall raced) is re-observed
      // and re-tombstoned next tick with a fresh window.
      toDelete.push({ agentId: row.agentId, skillId: row.skillId, notRewrittenSinceIso });
    } else {
      tombstonesNext[key] = existing; // still within grace — keep waiting.
    }
  }

  // Tombstones for pairs whose row is entirely gone (already deleted) are
  // dropped by not copying them forward — self-pruning.
  return { tombstonesNext, toDelete, clearedKeys, newlyTombstonedKeys, liveCount };
}

export async function runOrphanGc(deps: OrphanGcDeps): Promise<OrphanGcResult> {
  const now = deps.now ?? (() => new Date());
  const graceMs = deps.graceMs ?? SKILL_MATCH_ORPHAN_GC_GRACE_MS;
  const readAllRows = deps.readAllRows ?? defaultStore.readAllRows;
  const deleteOrphan = deps.deleteOrphanRowIfStale ?? defaultStore.deleteOrphanRowIfStale;
  const nowDate = now();

  // Fail closed: a false-empty catalog would tombstone-then-delete everything.
  const [rows, agents, skills, tombstones] = await Promise.all([
    readAllRows(),
    deps.catalog.readAgents(),
    deps.catalog.listSkills(),
    deps.readTombstones(),
  ]);
  const liveAgentIds = new Set(agents.map((a) => a.packageId));
  const liveSkillIds = new Set(skills.map((s) => s.id));

  const plan = planOrphanGc(rows, liveAgentIds, liveSkillIds, tombstones, graceMs, nowDate);

  let deleted = 0;
  const deletedPairs: { agentId: string; skillId: string }[] = [];
  for (const target of plan.toDelete) {
    const removed = await deleteOrphan(
      target.agentId,
      target.skillId,
      target.notRewrittenSinceIso,
    );
    if (removed > 0) {
      deleted += removed;
      deletedPairs.push({ agentId: target.agentId, skillId: target.skillId });
    }
  }

  // Post-delete revalidation: if any just-deleted pair has REAPPEARED in the
  // catalog since our snapshot, re-enqueue an eval so a reinstall that raced
  // the delete is not left unmatched. Runs BEFORE the tombstone write so a
  // tombstone-write failure cannot skip the self-heal. One extra catalog read,
  // only when something was deleted. (A reinstall landing AFTER this second
  // read is covered by its own install/save hook, which always enqueues a fresh
  // eval — the guaranteed backstop.) Only a SUCCESSFUL re-enqueue is counted.
  let reenqueuedAfterRace = 0;
  if (deletedPairs.length > 0 && deps.enqueueReeval) {
    const [agents2, skills2] = await Promise.all([
      deps.catalog.readAgents(),
      deps.catalog.listSkills(),
    ]);
    const liveAgents2 = new Set(agents2.map((a) => a.packageId));
    const liveSkills2 = new Set(skills2.map((s) => s.id));
    for (const pair of deletedPairs) {
      if (liveAgents2.has(pair.agentId) && liveSkills2.has(pair.skillId)) {
        try {
          await deps.enqueueReeval(pair.agentId, pair.skillId);
          reenqueuedAfterRace += 1;
        } catch (err) {
          console.warn("[skill-match] maintenance re-enqueue after race failed:", err);
        }
      }
    }
  }

  await deps.writeTombstones(plan.tombstonesNext);

  // Prune drift flags for pairs we deleted.
  if (deps.clearDriftFlags && deletedPairs.length > 0) {
    await deps
      .clearDriftFlags(deletedPairs.map((p) => pairKey(p.agentId, p.skillId)))
      .catch((err) => console.warn("[skill-match] maintenance drift-flag prune failed:", err));
  }

  const result: OrphanGcResult = {
    scanned: rows.length,
    live: plan.liveCount,
    newlyTombstoned: plan.newlyTombstonedKeys.length,
    deleted,
    reenqueuedAfterRace,
    clearedTombstones: plan.clearedKeys.length,
  };
  console.info(JSON.stringify({ event: "skill_match_maintenance_orphan_gc", ...result }));
  return result;
}

// ===========================================================================
// 3. Drift-flag recording
// ===========================================================================

/**
 * Pure reducer. Cumulative-per-fingerprint counting: a drift observation
 * increments the pair's counter; a fingerprint change (input hashes or
 * evaluator version) RESETS the count to 0 first, because drift is the SAME
 * inputs producing a different decision — a fingerprint change is a legitimate
 * re-eval, not model drift. A non-drift observation does not reset a cumulative
 * counter, but it DOES drop a record left over from an old (now-changed)
 * fingerprint.
 */
export function applyDriftObservations(
  current: DriftFlagMap,
  observations: DriftObservationInput[],
  threshold: number,
  now: Date,
): DriftFlagMap {
  const next: DriftFlagMap = { ...current };
  for (const obs of observations) {
    const key = pairKey(obs.agentId, obs.skillId);
    const existing = next[key];
    const fingerprintChanged =
      !!existing &&
      (existing.agentInputHash !== obs.agentInputHash ||
        existing.skillInputHash !== obs.skillInputHash ||
        existing.evaluatorVersion !== obs.evaluatorVersion);

    if (!obs.isDrift) {
      // Stable on current inputs — drop an obsolete record for changed inputs;
      // otherwise leave the cumulative count untouched.
      if (existing && fingerprintChanged) delete next[key];
      continue;
    }

    const base = existing && !fingerprintChanged ? existing.count : 0;
    const count = base + 1;
    next[key] = {
      agentId: obs.agentId,
      skillId: obs.skillId,
      count,
      lastDriftAt: now.toISOString(),
      lastKind: obs.kind,
      agentInputHash: obs.agentInputHash,
      skillInputHash: obs.skillInputHash,
      evaluatorVersion: obs.evaluatorVersion,
      flagged: count >= threshold,
    };
  }
  return next;
}

export type DriftRecordDeps = {
  readDriftFlags: () => Promise<DriftFlagMap>;
  writeDriftFlags: (map: DriftFlagMap) => Promise<void>;
  threshold?: number;
  now?: () => Date;
};

export async function recordDriftObservations(
  observations: DriftObservationInput[],
  deps: DriftRecordDeps,
): Promise<DriftFlagMap> {
  const now = deps.now ?? (() => new Date());
  const threshold = deps.threshold ?? SKILL_MATCH_DRIFT_FLAG_THRESHOLD;
  const current = await deps.readDriftFlags();
  const next = applyDriftObservations(current, observations, threshold, now());
  await deps.writeDriftFlags(next);
  return next;
}

// ===========================================================================
// Combined maintenance tick (GC then sweep)
// ===========================================================================

export type MaintenanceTickResult = { orphanGc: OrphanGcResult; sweep: StaleSweepResult };

/**
 * The scheduled maintenance tick: orphan GC first (so the sweep does not waste
 * a resolve on rows that are about to be deleted), then the staleness sweep.
 * The two share the same injected deps surface. Runs single-flight under a
 * fixed BullMQ jobId (see constants).
 */
export async function handleMaintenanceTick(
  deps: OrphanGcDeps & SweepDeps,
): Promise<MaintenanceTickResult> {
  const orphanGc = await runOrphanGc(deps);
  const sweep = await sweepStaleMatches(deps);
  return { orphanGc, sweep };
}

// ===========================================================================
// Maintenance KV (orphan tombstones / drift flags / manual-inputs-changed set).
// Plain connector_config blobs — no migration. Injected into the maintenance
// deps at the dispatch site; the reads double as the admin surfacing reads.
// ===========================================================================

export function readSkillMatchOrphanTombstones(): OrphanTombstoneMap {
  return readConnectorConfigFromDatabase<{ tombstones: OrphanTombstoneMap }>(
    "skill_match_orphan_tombstones",
    { tombstones: {} },
  ).tombstones;
}

export function writeSkillMatchOrphanTombstones(tombstones: OrphanTombstoneMap): void {
  writeConnectorConfigToDatabase("skill_match_orphan_tombstones", { tombstones });
}

export function readSkillMatchDriftFlags(): DriftFlagMap {
  return readConnectorConfigFromDatabase<{ flags: DriftFlagMap }>("skill_match_drift_flags", {
    flags: {},
  }).flags;
}

export function writeSkillMatchDriftFlags(flags: DriftFlagMap): void {
  writeConnectorConfigToDatabase("skill_match_drift_flags", { flags });
}

/** Prune drift-flag records for the given pair keys (called by the orphan GC). */
export function clearSkillMatchDriftFlagsForPairKeys(pairKeys: string[]): void {
  if (pairKeys.length === 0) return;
  const flags = readSkillMatchDriftFlags();
  let changed = false;
  for (const key of pairKeys) {
    if (key in flags) {
      delete flags[key];
      changed = true;
    }
  }
  if (changed) writeSkillMatchDriftFlags(flags);
}

export function readSkillMatchManualStale(): Array<{ agentId: string; skillId: string }> {
  return readConnectorConfigFromDatabase<{ pairs: Array<{ agentId: string; skillId: string }> }>(
    "skill_match_manual_stale",
    { pairs: [] },
  ).pairs;
}

/** Replace the manual-inputs-changed set (the sweep computes the full set). */
export function writeSkillMatchManualStale(
  pairs: Array<{ agentId: string; skillId: string }>,
): void {
  writeConnectorConfigToDatabase("skill_match_manual_stale", { pairs });
}
