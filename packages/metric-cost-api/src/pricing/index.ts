// TODO: ALL pricing values are LOW confidence — verify against current provider pricing pages
// before first production deployment. See:
// - OpenAI: https://openai.com/api/pricing
// - Anthropic: https://anthropic.com/pricing
// - Gemini: https://ai.google.dev/gemini-api/docs/pricing

import { eq } from "drizzle-orm";
import { db } from "../db";
import { modelPricing } from "../schema";

export type ModelPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  reasoningOutputPerMillion?: number;
};

// TODO: Verify all values against current provider pricing pages
export const LLM_PRICING: Record<string, ModelPricing> = {
  // OpenAI — https://openai.com/api/pricing
  "gpt-5.5":          { inputPerMillion: 5.00, outputPerMillion: 30.00, cachedInputPerMillion: 0.50 },
  "gpt-5":            { inputPerMillion: 2.50, outputPerMillion: 10.00, cachedInputPerMillion: 1.25 },
  "gpt-4o":           { inputPerMillion: 2.50, outputPerMillion: 10.00, cachedInputPerMillion: 1.25 },
  "gpt-4o-mini":      { inputPerMillion: 0.15, outputPerMillion: 0.60,  cachedInputPerMillion: 0.075 },
  // Anthropic — https://anthropic.com/pricing
  "claude-sonnet-4-5-20250929": { inputPerMillion: 3.00, outputPerMillion: 15.00, cachedInputPerMillion: 0.30 },
  "claude-opus-4":    { inputPerMillion: 15.00, outputPerMillion: 75.00, cachedInputPerMillion: 1.50 },
  // Gemini — https://ai.google.dev/gemini-api/docs/pricing
  "gemini-2.5-flash": { inputPerMillion: 0.075, outputPerMillion: 0.30 },
  "gemini-2.5-pro":   { inputPerMillion: 1.25, outputPerMillion: 10.00 },
};

export const APOLLO_PRICING = {
  peopleSearchPerRequest: 0,
  peopleEnrichmentPerCredit: 0.04,  // TODO: Verify against current Apollo plan
};

async function lookupModelPricingFromDb(model: string): Promise<{
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number | undefined;
} | null> {
  try {
    const rows = await db
      .select()
      .from(modelPricing)
      .where(eq(modelPricing.modelName, model))
      .limit(1);
    if (!rows[0]) return null;
    return {
      inputPerMillion:     parseFloat(rows[0].inputCostPerMillion as string),
      outputPerMillion:    parseFloat(rows[0].outputCostPerMillion as string),
      cacheReadPerMillion: rows[0].cacheReadPerMillion
                             ? parseFloat(rows[0].cacheReadPerMillion as string)
                             : undefined,
    };
  } catch (err) {
    // DB failure must not crash cost computation — fall through to hardcoded fallback
    console.error("[metric-cost-api] DB pricing lookup failed, using hardcoded fallback:", err);
    return null;
  }
}

/**
 * Compute cost for an LLM call. Returns null (not 0) when model has no pricing entry.
 * cost_usd is stored as NULL for unknown models so pricing gaps are detectable.
 * DB lookup takes precedence over hardcoded LLM_PRICING; falls back on DB failure.
 */
export async function computeLlmCostUsd(params: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): Promise<number | null> {
  // DB lookup takes precedence when live pricing exists.
  const dbPricing = await lookupModelPricingFromDb(params.model);
  const pricing: ModelPricing | undefined = dbPricing
    ? {
        inputPerMillion: dbPricing.inputPerMillion,
        outputPerMillion: dbPricing.outputPerMillion,
        cachedInputPerMillion: dbPricing.cacheReadPerMillion,
      }
    : LLM_PRICING[params.model];

  // Hardcoded pricing remains as a fallback when the DB has no entry.
  if (!pricing) return null;

  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  const billableInput = params.inputTokens - params.cachedInputTokens;

  // Anthropic 3-field sum: base rate for input_tokens, 10% rate for cache_read, 125% rate for cache_creation
  const cacheReadCost = ((params.cacheReadInputTokens ?? 0) / 1_000_000) * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion * 0.1);
  const cacheCreationCost = ((params.cacheCreationInputTokens ?? 0) / 1_000_000) * (pricing.inputPerMillion * 1.25);

  const inputCost = (Math.max(0, billableInput) / 1_000_000) * pricing.inputPerMillion
    + (params.cachedInputTokens / 1_000_000) * cachedRate
    + cacheReadCost
    + cacheCreationCost;
  const outputCost = (params.outputTokens / 1_000_000) * pricing.outputPerMillion;

  return inputCost + outputCost;
}

/**
 * Compute cost for an Apollo API call.
 */
export function computeApolloCostUsd(params: {
  operation: string;
  creditsConsumed: number;
}): number {
  if (params.creditsConsumed === 0) return 0;
  return params.creditsConsumed * APOLLO_PRICING.peopleEnrichmentPerCredit;
}
