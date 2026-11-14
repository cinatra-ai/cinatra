import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<{
    modelName: string;
    inputCostPerMillion: string;
    outputCostPerMillion: string;
    cacheReadPerMillion: string | null;
    source: string;
  }>,
}));

vi.mock("../src/store", () => ({
  upsertModelPricingRows: vi.fn(async (rows: typeof state.rows) => {
    state.rows = rows;
    return { inserted: rows.length, updated: 0 };
  }),
}));
vi.mock("../src/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => state.rows }) }) }) },
}));

import { runLiteLlmSync } from "../src/litellm-sync";
import { computeLlmCostUsd, LLM_PRICING } from "../src/pricing";

const usage = { model: "gemini-3.5-flash", inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 };

beforeEach(() => { state.rows = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Gemini rates are supplied by the online sync (#1714)", () => {
  it("has no copied 2.5 fallback and reports unknown cost before the current rate arrives", async () => {
    expect(LLM_PRICING[usage.model]).toBeUndefined();
    expect(LLM_PRICING["gemini-2.5-flash"]).toBeUndefined();
    expect(LLM_PRICING["gemini-2.5-pro"]).toBeUndefined();
    expect(await computeLlmCostUsd(usage)).toBeNull();
  });

  it("prices the catalog model from the synced row and follows subsequent source changes", async () => {
    // Source-shaped fixture, not a product rate card. A second sync changes
    // the fixture rate to prove the calculation uses the online-owned row.
    for (const inputPerMillion of [1.5, 2]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        "gemini/gemini-3.5-flash": {
          litellm_provider: "gemini",
          input_cost_per_token: inputPerMillion / 1_000_000,
          output_cost_per_token: 9 / 1_000_000,
          cache_read_input_token_cost: 0.15 / 1_000_000,
        },
      }), { headers: { "Content-Type": "application/json" } })));
      expect((await runLiteLlmSync()).inserted).toBe(1);
      expect(state.rows).toEqual([expect.objectContaining({
        modelName: usage.model, source: "litellm", cacheReadPerMillion: "0.15000000",
      })]);
      expect(await computeLlmCostUsd(usage)).toBeCloseTo(inputPerMillion + 9);
    }
  });
});
