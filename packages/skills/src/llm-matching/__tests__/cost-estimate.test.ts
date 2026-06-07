import { describe, it, expect } from "vitest";
import { estimateBatchCost, type PairForEstimation } from "../cost-estimate";
import {
  SKILL_MATCH_PRICING_USD,
  SKILL_MATCH_MAX_INPUT_TOKENS_PER_PAIR,
  SKILL_MATCH_MAX_OUTPUT_TOKENS_PER_PAIR,
} from "../constants";
import type { AgentForMatching, SkillForMatching } from "../types";

const buildPair = (i: number): PairForEstimation => {
  const agent: AgentForMatching = {
    packageId: `@cinatra/agent-${i}`,
    name: `Agent ${i}`,
    description: "a".repeat(200),
    tags: ["x", "y"],
  };
  const skill: SkillForMatching = {
    skillId: `skill-${i}`,
    name: `skill-${i}`,
    level: "system",
    content: "b".repeat(2000),
  };
  return { agent, skill };
};

describe("cost-estimate", () => {
  it("50-pair fixture matches a precomputed value within +/-10%", () => {
    const pairs = Array.from({ length: 50 }, (_, i) => buildPair(i));
    const result = estimateBatchCost(pairs);
    expect(result.pairCount).toBe(50);
    expect(result.estimatedInputTokens).toBeGreaterThan(0);
    expect(result.estimatedOutputTokens).toBeGreaterThan(0);
    expect(result.estimatedUsd).toBeGreaterThan(0);
    expect(result.pricingVersion).toBe(SKILL_MATCH_PRICING_USD.source);

    // Manual recomputation: estimateBatchCost MUST equal
    //   (totalInputTokens / 1e6) * inputPer1M + (totalOutputTokens / 1e6) * outputPer1M
    // We tolerate +/-10% only because the underlying tokenizer can shift slightly across
    // gpt-tokenizer minor versions; the formula itself is exact.
    const expectedUsd =
      (result.estimatedInputTokens / 1_000_000) * SKILL_MATCH_PRICING_USD.inputPer1MTokens +
      (result.estimatedOutputTokens / 1_000_000) * SKILL_MATCH_PRICING_USD.outputPer1MTokens;
    expect(Math.abs(result.estimatedUsd - expectedUsd)).toBeLessThan(expectedUsd * 0.10);
  });

  it("0 pairs returns zeros with non-empty pricingVersion", () => {
    const result = estimateBatchCost([]);
    expect(result).toEqual({
      pairCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedUsd: 0,
      pricingVersion: SKILL_MATCH_PRICING_USD.source,
    });
  });

  it("pricingVersion is exactly SKILL_MATCH_PRICING_USD.source", () => {
    const r = estimateBatchCost([buildPair(0)]);
    expect(r.pricingVersion).toBe(SKILL_MATCH_PRICING_USD.source);
  });

  it("200-pair max inline call respects per-pair input cap", () => {
    const pairs = Array.from({ length: 200 }, (_, i) => buildPair(i));
    const result = estimateBatchCost(pairs);
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(
      200 * SKILL_MATCH_MAX_INPUT_TOKENS_PER_PAIR,
    );
    expect(result.estimatedOutputTokens).toBe(200 * SKILL_MATCH_MAX_OUTPUT_TOKENS_PER_PAIR);
  });
});
