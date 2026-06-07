"use server";

import { writeSubscriptionCosts, writeBudgetConfig, insertLegacyCostEntry, updateLegacyCostEntry, deleteLegacyCostEntry, upsertModelPricingRows, updateModelPricingRow } from "./store";
import { revalidatePath } from "next/cache";
import { runLiteLlmSync } from "./litellm-sync";
import { randomUUID } from "node:crypto";

export async function saveSubscriptionCosts(formData: FormData) {
  const parsePositive = (raw: FormDataEntryValue | null): number | null => {
    const value = raw ? parseFloat(String(raw)) : NaN;
    return !isNaN(value) && value > 0 ? value : null;
  };

  const apolloMonthlyUsd = parsePositive(formData.get("apolloMonthlyUsd"));
  const apifyMonthlyUsd = parsePositive(formData.get("apifyMonthlyUsd"));

  await writeSubscriptionCosts({ apolloMonthlyUsd, apifyMonthlyUsd });
  revalidatePath("/analytics/llm");
}

export async function saveBudgetConfig(formData: FormData) {
  const raw = formData.get("monthlyBudgetUsd");
  const value = raw ? parseFloat(String(raw)) : null;
  const monthlyBudgetUsd = value !== null && !isNaN(value) && value > 0 ? value : null;

  await writeBudgetConfig({ monthlyBudgetUsd });
  revalidatePath("/analytics/llm");
}

// ---------------------------------------------------------------------------
// Legacy cost entry CRUD
// ---------------------------------------------------------------------------

const VALID_FREQUENCIES = ["once", "monthly", "yearly"] as const;
function sanitizeFrequency(raw: unknown): string {
  const val = String(raw ?? "").trim();
  return (VALID_FREQUENCIES as readonly string[]).includes(val) ? val : "once";
}

const VALID_COST_TYPES = ["legacy", "subscription"] as const;
function sanitizeCostType(raw: unknown): string {
  const val = String(raw ?? "").trim();
  return (VALID_COST_TYPES as readonly string[]).includes(val) ? val : "legacy";
}

export async function saveLegacyCost(formData: FormData) {
  const provider    = String(formData.get("provider") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const rawCost     = formData.get("costUsd");
  const frequency   = sanitizeFrequency(formData.get("frequency"));
  const costType    = sanitizeCostType(formData.get("costType"));
  const startDate   = String(formData.get("startDate") ?? "").trim() || null;
  const endDate     = String(formData.get("endDate") ?? "").trim() || null;

  const costUsd = rawCost ? parseFloat(String(rawCost)) : NaN;
  if (!provider || !description || isNaN(costUsd) || costUsd <= 0) return;

  await insertLegacyCostEntry({ provider, description, costUsd, frequency, costType, startDate, endDate });
  revalidatePath("/analytics/llm");
}

export async function updateLegacyCostAction(formData: FormData) {
  const id          = String(formData.get("id") ?? "").trim();
  const provider    = String(formData.get("provider") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const rawCost     = formData.get("costUsd");
  const frequency   = sanitizeFrequency(formData.get("frequency"));
  const costType    = sanitizeCostType(formData.get("costType"));
  const startDate   = String(formData.get("startDate") ?? "").trim() || null;
  const endDate     = String(formData.get("endDate") ?? "").trim() || null;

  const costUsd = rawCost ? parseFloat(String(rawCost)) : NaN;
  if (!id || !provider || !description || isNaN(costUsd) || costUsd <= 0) return;

  await updateLegacyCostEntry({ id, provider, description, costUsd, frequency, costType, startDate, endDate });
  revalidatePath("/analytics/llm");
}

export async function deleteLegacyCostAction(formData: FormData) {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;

  await deleteLegacyCostEntry(id);
  revalidatePath("/analytics/llm");
}

// ---------------------------------------------------------------------------
// Model pricing CRUD
// ---------------------------------------------------------------------------

export async function upsertModelPricingAction(formData: FormData) {
  const id            = String(formData.get("id") ?? "").trim();
  const provider      = String(formData.get("provider") ?? "").trim();
  const modelName     = String(formData.get("modelName") ?? "").trim();
  const rawInput      = formData.get("inputCostPerMillion");
  const rawOutput     = formData.get("outputCostPerMillion");
  const rawCache      = formData.get("cacheReadPerMillion");

  const inputCost  = rawInput  ? parseFloat(String(rawInput))  : NaN;
  const outputCost = rawOutput ? parseFloat(String(rawOutput)) : NaN;

  if (!provider || !modelName || isNaN(inputCost) || isNaN(outputCost)) return;

  const cacheRead = rawCache ? parseFloat(String(rawCache)) : NaN;

  if (id) {
    // Edit path — direct UPDATE by id, bypasses upsert setWhere guard
    await updateModelPricingRow(id, {
      inputCostPerMillion:  inputCost.toFixed(8),
      outputCostPerMillion: outputCost.toFixed(8),
      cacheReadPerMillion:  !isNaN(cacheRead) ? cacheRead.toFixed(8) : null,
    });
  } else {
    // Create path — new row via upsert
    await upsertModelPricingRows([{
      id: randomUUID(),
      provider,
      modelName,
      inputCostPerMillion:  inputCost.toFixed(8),
      outputCostPerMillion: outputCost.toFixed(8),
      cacheReadPerMillion:  !isNaN(cacheRead) ? cacheRead.toFixed(8) : null,
      source: "manual",
    }]);
  }
  revalidatePath("/analytics/llm/pricing");
}

export async function triggerLiteLlmSyncAction() {
  try {
    const result = await runLiteLlmSync();
    revalidatePath("/analytics/llm/pricing");
    return result;
  } catch (err) {
    // Drizzle wraps the real DB error in err.cause — extract it server-side
    // before the error crosses the server/client boundary (where cause is lost).
    const cause = (err as { cause?: unknown })?.cause;
    const errorMessage =
      (cause instanceof Error ? cause.message : null) ??
      (err instanceof Error ? err.message : "Unknown error");
    return { inserted: 0, updated: 0, skipped: 0, errors: 1, errorMessage };
  }
}
