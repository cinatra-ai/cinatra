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

// ---------------------------------------------------------------------------
// PER-IMAGE rate card (cinatra#2641)
// ---------------------------------------------------------------------------

/**
 * What one image model costs, in every unit its provider bills it in.
 *
 * SEPARATE FROM {@link LLM_PRICING} on purpose. That card is per MILLION TOKENS
 * of a text completion, and an image row's dominant charge is per IMAGE —
 * running the text card over an image row answers `0`, and a stored `0` reads as
 * "this image was free". Two units, two cards; no row is ever priced by the
 * wrong one.
 *
 * EVERY COMPONENT A PROVIDER BILLS MUST APPEAR HERE. A card that lists only the
 * per-image charge for a provider that ALSO bills the prompt produces a partial
 * total, and a partial total stored in `cost_usd` renders exactly like a
 * complete one — the same laundering `SUM(cost_usd)` does over NULLs.
 */
export type ImagePricing = {
  /** USD per produced image. */
  perImageUsd: number;
  /**
   * USD per MILLION prompt tokens, when the provider bills the request as well
   * as the images. Omitted only for a provider that bills a flat per-image price
   * and nothing else.
   *
   * DECLARING IT MAKES THE PROMPT-TOKEN COUNT MANDATORY: without it
   * {@link computeImageCostUsd} answers null rather than pricing the images and
   * silently dropping the rest of the bill.
   */
  inputPerMillion?: number;
  /**
   * The provider SERVICE TIER these rates are quoted at. Providers publish
   * several (Google lists Standard, Batch, Flex and Priority for its image
   * models, spanning a 3.6x range on the same model), so a rate with no tier is
   * ambiguous. The card carries the tier the adapter path actually uses; a call
   * issued on another tier is a different rate and needs its own entry.
   */
  tier: string;
  /**
   * The date these rates were read off {@link source}. Provider prices move —
   * this model's input rate has moved within the last quarter — and a rate with
   * no date is a claim nobody can re-check.
   */
  asOf: string;
  /** The provider's own published pricing page the rates came from. */
  source: string;
};

/**
 * Per-image rates, keyed by `provider` and then by the model identifier the
 * adapter ADDRESSED for the image.
 *
 * KEYED BY PROVIDER TOO, not by model alone: a model NAME is a string an adapter
 * chooses, so a non-Google adapter reporting "gemini-2.5-flash-image" would
 * otherwise be billed at Google's rate. The provider comes from the adapter the
 * seam wrapped, which is the one identity in the row a connector cannot spoof by
 * naming a string.
 *
 * WHAT IS IN HERE, AND WHY SO LITTLE. A model earns an entry only when its
 * provider publishes an unambiguous price for the way this repo calls it. The
 * image models whose price depends on output RESOLUTION are deliberately ABSENT
 * — as of the date below Google prices Gemini 3 Pro Image at $0.134/image for
 * 1K-2K and $0.24/image for 4K, and Gemini 3.1 Flash Image across four
 * resolution tiers, while the ABI's image response reports no resolution.
 * Picking one of those tiers would be inventing a number. A missing entry yields
 * `null`, this module's "unknown" signal, which the dashboard surfaces as an
 * explicit unknown cost — the same honest outcome the path had before it was
 * priceable at all.
 *
 * Adding a model here is the whole act of pricing it: no other code changes.
 */
export const IMAGE_PRICING: Record<string, Record<string, ImagePricing>> = {
  gemini: {
    // https://ai.google.dev/gemini-api/docs/pricing, STANDARD tier, read
    // 2026-08-11. Image output, verbatim: "Image output is priced at $30 per
    // 1,000,000 tokens. Output images up to 1024x1024px consume 1290 tokens and
    // are equivalent to $0.039 per image." The page states no resolution or
    // aspect-ratio tiers for this model, and the connector's image path requests
    // no resolution. Input, same row: "$0.30 (text / image)" per 1M tokens.
    //
    // STANDARD is the tier the connector's synchronous `generateContent` call
    // lands on — it selects no service tier. The same page prices Batch and Flex
    // at $0.0195/image + $0.15/1M and Priority at $0.0702/image + $0.54/1M, so a
    // future image path that opts into a tier is a DIFFERENT rate and needs its
    // own entry rather than this one.
    "gemini-2.5-flash-image": {
      perImageUsd: 0.039,
      inputPerMillion: 0.3,
      tier: "standard",
      asOf: "2026-08-11",
      source: "https://ai.google.dev/gemini-api/docs/pricing",
    },
  },
};

/** Prototype-safe two-level lookup. See {@link computeImageCostUsd}. */
function lookupImagePricing(
  provider: string | null | undefined,
  model: string | null | undefined,
): ImagePricing | null {
  if (!provider || !model) return null;
  // `hasOwnProperty` and not plain indexing: a provider or model literally named
  // "constructor" or "toString" would otherwise resolve to a prototype member
  // and be treated as a rate table / a rate.
  if (!Object.prototype.hasOwnProperty.call(IMAGE_PRICING, provider)) return null;
  const byModel = IMAGE_PRICING[provider];
  if (!Object.prototype.hasOwnProperty.call(byModel, model)) return null;
  return byModel[model];
}

/**
 * Cost of an image invocation: images x the per-image rate, PLUS the prompt
 * charge when the provider bills one.
 *
 * Returns `null` — never `0`, and never a partial — for every case where the
 * complete answer is not known:
 *
 *   - the adapter attested NO image usage (`images` absent). "Said nothing" and
 *     "billed nothing" are different claims and only one of them is safe;
 *   - the count is not a positive safe integer, so it cannot be multiplied by a
 *     dollar rate without inventing a number;
 *   - the provider/model pair has no entry, including the "unknown" the seam
 *     writes when no model was attested;
 *   - the entry declares an input rate and no prompt-token count was reported.
 *     Pricing the images alone would store a number that is short by the whole
 *     prompt charge and looks complete.
 *
 * `null` is what the subscriber stores as `cost_usd` NULL, which is exactly the
 * counted-but-unpriced row this path already wrote before it was priceable. So
 * every failure of this function degrades to the previous behaviour rather than
 * to a wrong price.
 *
 * The DB `model_pricing` override is deliberately NOT consulted: its columns are
 * per-million-token rates for a text completion, and neither of them is a
 * per-image rate. A per-image override belongs in its own table, which no
 * operator has asked for yet.
 */
export function computeImageCostUsd(params: {
  provider: string | null | undefined;
  model: string | null | undefined;
  images: number | null | undefined;
  inputTokens?: number | null | undefined;
}): number | null {
  const { images, inputTokens } = params;
  if (typeof images !== "number" || !Number.isSafeInteger(images) || images <= 0) {
    return null;
  }

  const pricing = lookupImagePricing(params.provider, params.model);
  if (!pricing) return null;

  let cost = images * pricing.perImageUsd;

  if (pricing.inputPerMillion !== undefined) {
    if (
      typeof inputTokens !== "number" ||
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0
    ) {
      return null;
    }
    cost += (inputTokens / 1_000_000) * pricing.inputPerMillion;
  }

  return cost;
}

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
  // `Number.isFinite` and not `> 0` alone: Infinity is a positive number and
  // would price the row at Infinity.
  const multiplier =
    Number.isFinite(params.rateMultiplier) && (params.rateMultiplier as number) > 0
      ? (params.rateMultiplier as number)
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
