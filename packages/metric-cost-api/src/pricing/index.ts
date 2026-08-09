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
  // Canonical OpenAI default; without this fallback, gpt-5.5 usage records NULL cost_usd (#271).
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
  // NON-INFERENCE provider calls the platform makes and COUNTS, but that bill
  // nothing. Today that is the LLM-access key-validation probe's catalog read
  // (cinatra#2579), which emits a zero-token usage event so validation is
  // visible in /analytics/llm. Priced EXPLICITLY at zero: a missing entry
  // yields cost_usd = NULL, and NULL is this module's "unknown model" signal —
  // the cost summary surfaces it as "event(s) have unknown cost (missing model
  // pricing)". A call we know is free must not read as a pricing GAP.
  "models.list":      { inputPerMillion: 0, outputPerMillion: 0 },
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
 * The ASYNCHRONOUS-BATCH rate multiplier, by provider (cinatra#2578).
 *
 * The rate card this module prices against is the SYNCHRONOUS one. Both
 * providers that offer a batch surface bill asynchronous batch work at half the
 * synchronous rate on input AND output, so pricing a batch row off the plain
 * card would overstate that spend by ~2x. Since the ledger's whole purpose is to
 * tell an operator what they actually spend, "invisible" must not be replaced by
 * "materially wrong in the other direction".
 *
 * A provider absent from this table gets 1.0 — no discount is ASSUMED for a
 * surface whose batch terms we do not know.
 */
const BATCH_RATE_MULTIPLIER_BY_PROVIDER: Record<string, number> = {
  openai: 0.5,
  anthropic: 0.5,
};

export function batchRateMultiplier(provider: string): number {
  return Object.prototype.hasOwnProperty.call(
    BATCH_RATE_MULTIPLIER_BY_PROVIDER,
    provider,
  )
    ? BATCH_RATE_MULTIPLIER_BY_PROVIDER[provider]
    : 1;
}

/**
 * Compute cost for an LLM call. Returns null (not 0) when model has no pricing entry.
 * cost_usd is stored as NULL for unknown models so pricing gaps are detectable.
 * DB lookup takes precedence over hardcoded LLM_PRICING; falls back on DB failure.
 *
 * `rateMultiplier` (cinatra#2578) scales the whole computation for a surface
 * billed off the synchronous card — today only asynchronous batch. Absent ⇒ 1,
 * so every existing caller is byte-identical.
 */
export async function computeLlmCostUsd(params: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  rateMultiplier?: number;
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

  // Applied to the TOTAL: every provider that discounts batch discounts both
  // legs, so scaling once here keeps the cache terms consistent with the rest.
  const multiplier =
    typeof params.rateMultiplier === "number" && params.rateMultiplier > 0
      ? params.rateMultiplier
      : 1;
  return (inputCost + outputCost) * multiplier;
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
