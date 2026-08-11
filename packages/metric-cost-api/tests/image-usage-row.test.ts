/**
 * cinatra#2641 — an image-generation call reaches `usage_events` as a COUNTED,
 * UNPRICED row.
 *
 * `adapter.generateImage()` is billed PER IMAGE and answers with an image and
 * nothing else: no usage object, no model name. The metering seam therefore
 * books the one true statement — an image call happened, on this provider, for
 * this caller — with zero token columns (a schema requirement, not a
 * measurement) and NO dollars.
 *
 * What is pinned here is the subscriber's half of that: the per-TOKEN rate card
 * is never run over an `image` row. Running it would answer 0 for zero tokens
 * and store "0.00000000", which reads as "this image was free" — the precise
 * failure `cost_usd` NULL exists to avoid. cinatra#2582 established the shape
 * for the Graphiti hand-over; this is the same shape at the adapter seam.
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

const imageEvent = (overrides: Record<string, unknown> = {}) =>
  ({
    source: "llm",
    provider: "gemini",
    model: "unknown",
    operation: "image",
    agentLabel: "blog-post-image",
    skillLabel: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    idempotencyKey: "image:fixture-1",
    occurredAt: "2026-08-11T10:00:00.000Z",
    ...overrides,
  }) as never;

beforeEach(() => {
  insertUsageEvent.mockReset().mockResolvedValue(undefined);
  // A rate card that WOULD answer if it were asked. Mocking it to a number is
  // what makes "never priced" an assertion rather than a coincidence of zeros.
  computeLlmCostUsd.mockReset().mockResolvedValue(4.56);
  startUsageEventSubscriber(); // internally idempotent
});

describe("an image usage event becomes an unpriced usage_events row", () => {
  it("persists it with NULL cost and keeps the caller's attribution", async () => {
    emitUsageEvent(imageEvent());
    await settle();

    expect(insertUsageEvent).toHaveBeenCalledTimes(1);
    const row = insertUsageEvent.mock.calls[0]![0];
    expect(row).toMatchObject({
      source: "llm",
      provider: "gemini",
      operation: "image",
      agentLabel: "blog-post-image",
      // NULL, not 0: "we do not know what this image cost" and "this image was
      // free" are different claims, and only one of them is true.
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      creditsConsumed: 0,
      idempotencyKey: "image:fixture-1",
    });
    expect(row.occurredAt).toBeInstanceOf(Date);
  });

  it("never runs the per-token rate card over it", async () => {
    emitUsageEvent(imageEvent({ idempotencyKey: "image:fixture-2" }));
    await settle();

    expect(computeLlmCostUsd).not.toHaveBeenCalled();
  });

  it("refuses the card even when the caller named a PRICED model", async () => {
    // The dangerous shape: a model the card knows, against zero tokens. Pricing
    // it would store $0.00000000 with full confidence.
    emitUsageEvent(
      imageEvent({ model: "gpt-5.5", idempotencyKey: "image:fixture-3" }),
    );
    await settle();

    expect(computeLlmCostUsd).not.toHaveBeenCalled();
    expect(insertUsageEvent.mock.calls[0]![0]).toMatchObject({
      model: "gpt-5.5",
      costUsd: null,
    });
  });

  it("leaves every other llm operation priced exactly as before", async () => {
    // The guard is scoped to `image` and to nothing else — a token-reporting
    // call must still get its dollars.
    emitUsageEvent(
      imageEvent({
        operation: "generate",
        model: "gpt-5.5",
        inputTokens: 100,
        outputTokens: 20,
        idempotencyKey: "image:fixture-4",
      }),
    );
    await settle();

    expect(computeLlmCostUsd).toHaveBeenCalledTimes(1);
    expect(insertUsageEvent.mock.calls[0]![0]).toMatchObject({
      operation: "generate",
      costUsd: "4.56000000",
    });
  });
});
