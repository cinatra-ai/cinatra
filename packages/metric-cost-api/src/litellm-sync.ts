import "server-only";
import { randomUUID } from "node:crypto";
import { upsertModelPricingRows } from "./store";

const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const FETCH_TIMEOUT_MS = 30_000;

export type LiteLlmSyncResult = {
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  errorMessage?: string;
};

/**
 * Fetch LiteLLM model pricing JSON, transform per-token rates to per-million,
 * and upsert into model_pricing table. Manual rows (source = 'manual') are
 * protected by the conditional upsert in upsertModelPricingRows.
 */
export async function runLiteLlmSync(): Promise<LiteLlmSyncResult> {
  const response = await fetch(LITELLM_PRICES_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`LiteLLM fetch failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const rows: Array<{
    id: string;
    provider: string;
    modelName: string;
    inputCostPerMillion: string;
    outputCostPerMillion: string;
    cacheReadPerMillion: string | null;
    source: string;
  }> = [];
  let skipped = 0;

  for (const [modelKey, entry] of Object.entries(data)) {
    // Skip the documentation/sample key
    if (modelKey === "sample_spec") {
      skipped++;
      continue;
    }

    const e = entry as Record<string, unknown>;
    const inputPerToken = e.input_cost_per_token as number | undefined;
    const outputPerToken = e.output_cost_per_token as number | undefined;

    // Skip models without both input and output pricing (embeddings, image gen, etc.)
    if (inputPerToken == null || outputPerToken == null) {
      skipped++;
      continue;
    }

    // Extract provider: prefer litellm_provider field, fallback to key prefix
    const provider = (e.litellm_provider as string | undefined)
      ?? (modelKey.includes("/") ? modelKey.split("/")[0] : "unknown");

    // Strip provider prefix from model key when present
    // e.g. "gemini/gemini-2.5-flash" -> "gemini-2.5-flash"
    // e.g. "gpt-4o" -> "gpt-4o" (no prefix)
    const modelName = modelKey.includes("/")
      ? modelKey.split("/").slice(1).join("/")
      : modelKey;

    // Convert per-token to per-million
    const inputPerMillion = inputPerToken * 1_000_000;
    const outputPerMillion = outputPerToken * 1_000_000;

    const cacheReadPerToken = e.cache_read_input_token_cost as number | undefined;
    const cacheReadPerMillion = cacheReadPerToken != null
      ? cacheReadPerToken * 1_000_000
      : null;

    // Skip models with prices that overflow numeric(12,8) — max 9999.99999999.
    // These are typically internal/test models (e.g. W&B hosted) with non-standard pricing.
    if (
      inputPerMillion > 9999 ||
      outputPerMillion > 9999 ||
      (cacheReadPerMillion != null && cacheReadPerMillion > 9999)
    ) {
      skipped++;
      continue;
    }

    rows.push({
      id: randomUUID(),
      provider,
      modelName,
      inputCostPerMillion: inputPerMillion.toFixed(8),
      outputCostPerMillion: outputPerMillion.toFixed(8),
      cacheReadPerMillion: cacheReadPerMillion != null ? cacheReadPerMillion.toFixed(8) : null,
      source: "litellm",
    });
  }

  if (rows.length === 0) {
    return { inserted: 0, updated: 0, skipped, errors: 0 };
  }

  const result = await upsertModelPricingRows(rows);

  console.log(
    `[litellm-sync] Synced ${rows.length} models (skipped ${skipped}):`,
    result,
  );

  return {
    inserted: result.inserted,
    updated: result.updated,
    skipped,
    errors: 0,
  };
}

/**
 * Entry point for BullMQ job dispatch. Wraps runLiteLlmSync with error handling.
 */
export async function runLiteLlmPricingSyncJob(
  _data: Record<string, never>,
): Promise<LiteLlmSyncResult> {
  console.log("[litellm-sync] Starting LiteLLM pricing sync job...");
  const result = await runLiteLlmSync();
  console.log("[litellm-sync] Job complete:", result);
  return result;
}
