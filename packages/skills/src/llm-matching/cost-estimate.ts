/**
 * Per-batch cost estimator. Used by the inline path for display-only estimates
 * and by the batch transport before submission.
 */

import { encode as encodeCl100k } from "gpt-tokenizer/encoding/cl100k_base";
import {
  SKILL_MATCH_PRICING_USD,
  SKILL_MATCH_MAX_INPUT_TOKENS_PER_PAIR,
  SKILL_MATCH_MAX_OUTPUT_TOKENS_PER_PAIR,
} from "./constants";
import { buildPromptForPair } from "./prompt-builder";
import type { AgentForMatching, SkillForMatching } from "./types";

// ---------------------------------------------------------------------------
// Pricing snapshot staleness canary.
//
// `SKILL_MATCH_PRICING_USD.capturedAt` is a hand-maintained snapshot of
// OpenAI's gpt-4o-mini pricing as of the date in `constants.ts`. OpenAI
// changes prices every few months; the displayed estimate silently drifts
// from the real bill over time. This warning is intentionally non-blocking:
// it surfaces stale estimates without failing unrelated builds.
//
// First use is `estimateBatchCost()` — the only call site that consumes
// `SKILL_MATCH_PRICING_USD` for end-user-visible numbers. We dedupe per
// process via a module-level boolean so a busy worker does not spam the
// log.
// ---------------------------------------------------------------------------

/** Days after which the captured pricing snapshot is considered stale. */
export const SKILL_MATCH_PRICING_STALE_DAYS = 90;

/** Process-wide dedupe so the warning fires at most ONCE per Node process. */
let pricingWarnedThisProcess = false;

/**
 * Compute pricing snapshot age in days. Pure function, exported for tests.
 * Returns the floor of the day count using the standard 86400000 ms/day
 * divisor — leap-second / DST shifts don't matter at the 90-day grain.
 */
export function getPricingFreshness(now: Date = new Date()): {
  capturedAt: string;
  ageDays: number;
  isStale: boolean;
} {
  const capturedAt = SKILL_MATCH_PRICING_USD.capturedAt;
  const capturedTs = Date.parse(capturedAt);
  const nowTs = now.getTime();
  // If capturedAt is malformed (Date.parse → NaN), treat as not-stale rather
  // than firing a misleading "ageDays = NaN" warning. The constants file is
  // a single source of truth — a malformed value is a build-time bug, not a
  // run-time one.
  if (Number.isNaN(capturedTs)) {
    return { capturedAt, ageDays: 0, isStale: false };
  }
  const ageDays = Math.floor((nowTs - capturedTs) / 86_400_000);
  return { capturedAt, ageDays, isStale: ageDays > SKILL_MATCH_PRICING_STALE_DAYS };
}

/**
 * Emit a structured `skill-match-pricing-stale` warning the first time the
 * snapshot is observed to be stale within this process. Idempotent across
 * repeated `estimateBatchCost()` calls.
 *
 * Exported for test verification (so the test can drive the side-effect
 * deterministically and reset the dedupe flag between cases).
 */
export function emitPricingStaleWarningIfNeeded(now: Date = new Date()): void {
  if (pricingWarnedThisProcess) return;
  const { capturedAt, ageDays, isStale } = getPricingFreshness(now);
  if (!isStale) return;
  pricingWarnedThisProcess = true;
  console.warn(
    JSON.stringify({
      event: "skill-match-pricing-stale",
      capturedAt,
      ageDays,
      staleThresholdDays: SKILL_MATCH_PRICING_STALE_DAYS,
      pricingVersion: SKILL_MATCH_PRICING_USD.source,
    }),
  );
}

/**
 * Test-only: reset the per-process dedupe flag so unit tests can assert
 * the "fires only once per process" behavior across multiple cases. Not
 * exported via the package barrel — only the test suite imports this.
 */
export function __resetPricingStaleDedupeForTests(): void {
  pricingWarnedThisProcess = false;
}

export type PairForEstimation = { agent: AgentForMatching; skill: SkillForMatching };

export type CostEstimate = {
  pairCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedUsd: number;
  pricingVersion: string;
};

export function estimateBatchCost(pairs: PairForEstimation[]): CostEstimate {
  // Fire the stale-pricing canary on first call after process start.
  // Idempotent: at most one warning per Node process. Side-effecting on a
  // "compute" function is unusual but safe here — `estimateBatchCost` is the
  // only consumer of the snapshot for user-visible numbers, and surfacing the
  // warning at any other point (boot, module init) would couple this concern
  // to lifecycle plumbing for no observable benefit.
  emitPricingStaleWarningIfNeeded();

  let totalInputTokens = 0;
  for (const { agent, skill } of pairs) {
    const { system, user } = buildPromptForPair(agent, skill);
    const tokenCount = Math.min(
      encodeCl100k(system).length + encodeCl100k(user).length,
      SKILL_MATCH_MAX_INPUT_TOKENS_PER_PAIR,
    );
    totalInputTokens += tokenCount;
  }
  const estimatedOutputTokens = pairs.length * SKILL_MATCH_MAX_OUTPUT_TOKENS_PER_PAIR;
  const estimatedUsd =
    (totalInputTokens / 1_000_000) * SKILL_MATCH_PRICING_USD.inputPer1MTokens +
    (estimatedOutputTokens / 1_000_000) * SKILL_MATCH_PRICING_USD.outputPer1MTokens;
  return {
    pairCount: pairs.length,
    estimatedInputTokens: totalInputTokens,
    estimatedOutputTokens,
    estimatedUsd,
    pricingVersion: SKILL_MATCH_PRICING_USD.source,
  };
}
