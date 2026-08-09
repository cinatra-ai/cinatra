import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// The key-validation probe is counted at ZERO — never as a pricing GAP.
//
// cinatra#2579 replaced the "Test key" agentic gpt-4o + remote-MCP loop with a
// catalog read that consumes no tokens, and emits a usage event for it so the
// validation is visible in /analytics/llm. `cost_usd = NULL` is this module's
// "unknown model" signal (the cost summary renders it as "event(s) have
// unknown cost (missing model pricing)"), so a call we KNOW is free must price
// to 0, not to null. These assertions pin both halves of that contract.
//
// Hermetic: `../src/db` is stubbed with a query chain that resolves empty, so
// the DB-pricing lookup returns null and the hardcoded fallback table decides
// — no Postgres, no connection attempt.
// ---------------------------------------------------------------------------

vi.mock("../src/db", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [] as unknown[],
  };
  return { db: { select: () => chain } };
});

const { computeLlmCostUsd, LLM_PRICING } = await import("../src/pricing");

const zeroTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

describe("key-validation probe pricing (cinatra#2579)", () => {
  it("prices the zero-token catalog read at 0 — not null", async () => {
    const cost = await computeLlmCostUsd({ model: "models.list", ...zeroTokens });
    expect(cost).toBe(0);
    expect(cost).not.toBeNull();
  });

  it("carries an explicit zero-rate entry so the fallback cannot drift back to null", () => {
    expect(LLM_PRICING["models.list"]).toEqual({ inputPerMillion: 0, outputPerMillion: 0 });
  });

  it("still reports a genuinely unknown model as null (the pricing-gap signal is intact)", async () => {
    const cost = await computeLlmCostUsd({ model: "not-a-model-we-price", ...zeroTokens });
    expect(cost).toBeNull();
  });
});
