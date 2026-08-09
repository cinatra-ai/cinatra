/**
 * cinatra#2578 — a batch row is priced at the BATCH rate, not the interactive one.
 *
 * The ledger began carrying OpenAI Batch spend in this change. The rate card
 * this package prices against is the SYNCHRONOUS one, and both providers that
 * offer a batch surface bill asynchronous batch work at half that. Pricing a
 * batch row off the plain card would replace "invisible spend" with "spend
 * overstated ~2x" — the same defect pointing the other way.
 *
 * `computeLlmCostUsd` therefore takes a `rateMultiplier`, and the subscriber
 * derives it from `{operation, provider}`. What is pinned here:
 *
 *   - the multiplier scales the WHOLE computation (input, cache terms, output);
 *   - it defaults to 1, so every pre-existing caller is unchanged;
 *   - a provider with no known batch terms gets 1 — no discount is ASSUMED;
 *   - an unpriced model still answers null, discount or not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
  metadataTable: {},
}));

import { computeLlmCostUsd, batchRateMultiplier } from "../src/pricing";

const PRICED_MODEL = "gpt-4o-mini";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("batchRateMultiplier", () => {
  it("halves the rate for the providers that offer a batch surface", () => {
    expect(batchRateMultiplier("openai")).toBe(0.5);
    expect(batchRateMultiplier("anthropic")).toBe(0.5);
  });

  it("assumes NO discount for a provider whose batch terms we do not know", () => {
    expect(batchRateMultiplier("gemini")).toBe(1);
    expect(batchRateMultiplier("some-future-provider")).toBe(1);
  });

  it("does not resolve inherited Object.prototype keys as rates", () => {
    expect(batchRateMultiplier("toString")).toBe(1);
    expect(batchRateMultiplier("constructor")).toBe(1);
  });
});

describe("computeLlmCostUsd — rateMultiplier", () => {
  it("is byte-identical to the undiscounted cost when omitted", async () => {
    const base = await computeLlmCostUsd({
      model: PRICED_MODEL,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
    });
    const explicitOne = await computeLlmCostUsd({
      model: PRICED_MODEL,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
      rateMultiplier: 1,
    });
    expect(base).not.toBeNull();
    expect(explicitOne).toBe(base);
  });

  it("scales the whole computation, cache terms included", async () => {
    const params = {
      model: PRICED_MODEL,
      inputTokens: 900_000,
      outputTokens: 100_000,
      cachedInputTokens: 200_000,
      cacheReadInputTokens: 50_000,
      cacheCreationInputTokens: 25_000,
    };
    const full = await computeLlmCostUsd(params);
    const batch = await computeLlmCostUsd({ ...params, rateMultiplier: 0.5 });

    expect(full).not.toBeNull();
    expect(batch).toBeCloseTo(full! * 0.5, 10);
  });

  it("still answers null for a model with no pricing entry", async () => {
    expect(
      await computeLlmCostUsd({
        model: "a-model-nobody-priced",
        inputTokens: 10,
        outputTokens: 10,
        cachedInputTokens: 0,
        rateMultiplier: 0.5,
      }),
    ).toBeNull();
  });

  it("ignores a nonsensical multiplier rather than zeroing a real cost", async () => {
    const base = await computeLlmCostUsd({
      model: PRICED_MODEL,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    // Infinity is a positive number and would otherwise price the row at
    // Infinity, so the guard is `Number.isFinite`, not `> 0`.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        await computeLlmCostUsd({
          model: PRICED_MODEL,
          inputTokens: 1_000_000,
          outputTokens: 0,
          cachedInputTokens: 0,
          rateMultiplier: bad,
        }),
      ).toBe(base);
    }
  });
});
