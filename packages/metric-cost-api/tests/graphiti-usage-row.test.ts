/**
 * cinatra#2582 — a Graphiti episode reaches `usage_events` as a COUNTED,
 * UNPRICED row.
 *
 * Graphiti's per-episode OpenAI fan-out happens in another container and the
 * pinned wrapper reports no token usage back, so the only truthful row is
 * "an episode was handed over; its dollars are unknown". `cost_usd` is
 * therefore NULL — which the dashboard already renders as an explicit
 * unknown-cost count — and never 0, which would read as "free".
 *
 * What is pinned here:
 *   - the row lands with source "graphiti", provider "openai", NULL cost;
 *   - it is NOT priced through the LLM rate card (no model to price against);
 *   - its idempotency key is passed through, so a re-emitted event cannot
 *     double-count;
 *   - a subscriber failure never escapes into the projection path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const insertUsageEvent = vi.fn<(row: Record<string, unknown>) => Promise<void>>();
const computeLlmCostUsd = vi.fn<(args: Record<string, unknown>) => Promise<number>>();

vi.mock("../src/store", () => ({
  insertUsageEvent: (row: Record<string, unknown>) => insertUsageEvent(row),
}));
vi.mock("../src/pricing", () => ({
  computeLlmCostUsd: (args: Record<string, unknown>) => computeLlmCostUsd(args),
  computeApolloCostUsd: () => 0,
  batchRateMultiplier: () => 1,
}));

import { emitUsageEvent } from "@cinatra-ai/metric-contracts";
import { startUsageEventSubscriber } from "../src/event-subscriber";

/** The bus is synchronous but the handler is async — let it settle. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  insertUsageEvent.mockReset().mockResolvedValue(undefined);
  computeLlmCostUsd.mockReset().mockResolvedValue(1.23);
  startUsageEventSubscriber(); // internally idempotent
});

describe("a graphiti episode event becomes an unpriced usage_events row", () => {
  it("persists it with NULL cost and no invented tokens", async () => {
    emitUsageEvent({
      source: "graphiti",
      provider: "openai",
      operation: "episode",
      model: null,
      idempotencyKey: "graphiti:episode:fixture-1",
      occurredAt: "2026-08-09T10:00:00.000Z",
    });
    await settle();

    expect(insertUsageEvent).toHaveBeenCalledTimes(1);
    const row = insertUsageEvent.mock.calls[0]![0];
    expect(row).toMatchObject({
      source: "graphiti",
      provider: "openai",
      operation: "episode",
      model: null,
      // NULL, not 0: "we do not know" and "it was free" are different claims.
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      creditsConsumed: 0,
      idempotencyKey: "graphiti:episode:fixture-1",
    });
    expect(row.occurredAt).toBeInstanceOf(Date);
  });

  it("never runs the LLM rate card over it", async () => {
    emitUsageEvent({
      source: "graphiti",
      provider: "openai",
      operation: "episode",
      model: null,
      idempotencyKey: "graphiti:episode:fixture-2",
      occurredAt: "2026-08-09T10:00:00.000Z",
    });
    await settle();

    // There is no model and no token count to price — deriving a number here
    // would be the fabrication this design exists to avoid.
    expect(computeLlmCostUsd).not.toHaveBeenCalled();
  });

  it("swallows a persistence failure instead of breaking the episode path", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    insertUsageEvent.mockRejectedValueOnce(new Error("db down"));

    expect(() =>
      emitUsageEvent({
        source: "graphiti",
        provider: "openai",
        operation: "episode",
        model: null,
        idempotencyKey: "graphiti:episode:fixture-3",
        occurredAt: "2026-08-09T10:00:00.000Z",
      }),
    ).not.toThrow();
    await settle();

    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
