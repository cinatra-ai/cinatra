/**
 * cinatra#2641 — how an image-generation call reaches `usage_events`.
 *
 * `adapter.generateImage()` is billed PER IMAGE, not per token. Two properties
 * of the subscriber are pinned here, and they are the whole of its half of this
 * issue:
 *
 *  1. THE PER-TOKEN CARD IS NEVER RUN OVER AN IMAGE ROW. An image row carries
 *     zero token columns (a schema requirement, not a measurement). Running the
 *     token card over those zeros answers 0 and stores "0.00000000", which reads
 *     as "this image was free" — the precise failure `cost_usd` NULL exists to
 *     avoid.
 *  2. IT IS PRICED FROM THE PER-IMAGE CARD WHEN — AND ONLY WHEN — THE ADAPTER
 *     REPORTED A COUNT. An adapter that reports the ABI's optional image usage
 *     yields a real price; one that reports nothing still yields the COUNTED,
 *     UNPRICED row (cost NULL) this path wrote before it was priceable, the
 *     shape cinatra#2582 established for the Graphiti hand-over.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const insertUsageEvent = vi.fn<(row: Record<string, unknown>) => Promise<void>>();
const computeLlmCostUsd = vi.fn<(args: Record<string, unknown>) => Promise<number>>();
const computeImageCostUsd =
  vi.fn<(args: Record<string, unknown>) => number | null>();

vi.mock("../src/store", () => ({
  insertUsageEvent: (row: Record<string, unknown>) => insertUsageEvent(row),
}));
vi.mock("../src/pricing", () => ({
  computeLlmCostUsd: (args: Record<string, unknown>) => computeLlmCostUsd(args),
  computeImageCostUsd: (args: Record<string, unknown>) => computeImageCostUsd(args),
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
  // A per-TOKEN card that WOULD answer if it were asked. Mocking it to a number
  // is what makes "never priced by tokens" an assertion rather than a
  // coincidence of zeros.
  computeLlmCostUsd.mockReset().mockResolvedValue(4.56);
  // The per-IMAGE card, defaulting to the unpriced answer it really gives for an
  // adapter that reported nothing.
  computeImageCostUsd.mockReset().mockReturnValue(null);
  startUsageEventSubscriber(); // internally idempotent
});

describe("an image usage event with NO reported usage stays unpriced", () => {
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

  it("refuses the TOKEN card even when the caller named a PRICED model", async () => {
    // The dangerous shape: a model the token card knows, against zero tokens.
    // Pricing it that way would store $0.00000000 with full confidence.
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

describe("an image usage event WITH a reported image count is priced", () => {
  it("prices it off the PER-IMAGE card and stores the dollars", async () => {
    // The state this issue's pricing half exists to reach: the adapter attested
    // which model produced the images, how many it was billed for and how large
    // the prompt was, so the row carries a real price instead of "unknown".
    computeImageCostUsd.mockReturnValue(0.078);

    emitUsageEvent(
      imageEvent({
        model: "gemini-2.5-flash-image",
        imageCount: 2,
        inputTokens: 1200,
        imagePromptTokensReported: true,
        idempotencyKey: "image:priced-1",
      }),
    );
    await settle();

    // The PROVIDER is part of the rate identity, not just the model: a model
    // name is a string an adapter chooses.
    expect(computeImageCostUsd).toHaveBeenCalledWith({
      provider: "gemini",
      model: "gemini-2.5-flash-image",
      images: 2,
      inputTokens: 1200,
    });
    // …and the per-TOKEN card is STILL never consulted. Being priceable must not
    // reopen the door the first half of this issue closed.
    expect(computeLlmCostUsd).not.toHaveBeenCalled();
    expect(insertUsageEvent.mock.calls[0]![0]).toMatchObject({
      operation: "image",
      model: "gemini-2.5-flash-image",
      costUsd: "0.07800000",
      // The prompt tokens the price was partly built from are stored in the
      // row's own column, so the row's numbers back its cost instead of
      // contradicting it. The OUTPUT stays zero — the output is the images.
      inputTokens: 1200,
      outputTokens: 0,
    });
  });

  it("falls back to the unpriced row when the card has no rate — the negative control", async () => {
    // Same event shape, a model the per-image card does not know. The row must
    // land exactly as it did before this path was priceable, not at $0.
    computeImageCostUsd.mockReturnValue(null);

    emitUsageEvent(
      imageEvent({
        model: "some-unlisted-image-model",
        imageCount: 1,
        idempotencyKey: "image:priced-2",
      }),
    );
    await settle();

    expect(computeImageCostUsd).toHaveBeenCalledTimes(1);
    expect(insertUsageEvent.mock.calls[0]![0]).toMatchObject({
      operation: "image",
      costUsd: null,
    });
  });

  it("passes an ABSENT count through as absent, never as zero", async () => {
    // `undefined` and `0` mean different things — "the adapter said nothing" and
    // "the adapter billed for no images" — and only the first is what a legacy
    // adapter is saying. Coercing it here would hand the card a number.
    emitUsageEvent(imageEvent({ idempotencyKey: "image:priced-3" }));
    await settle();

    expect(computeImageCostUsd).toHaveBeenCalledWith({
      provider: "gemini",
      model: "unknown",
      images: undefined,
      inputTokens: undefined,
    });
  });

  it("withholds an UNREPORTED prompt instead of passing the column's zero", async () => {
    // The trap this closes: the row's `input_tokens` column cannot be null, so
    // an adapter that reported NO prompt usage arrives here carrying `0`. Pass
    // that on unguarded and the card sees a valid "zero prompt tokens" report,
    // happily prices the images, and silently drops the whole prompt charge.
    // The reported-flag is the only thing that can say "unreported".
    emitUsageEvent(
      imageEvent({
        model: "gemini-2.5-flash-image",
        imageCount: 1,
        inputTokens: 0,
        // imagePromptTokensReported deliberately absent
        idempotencyKey: "image:priced-5",
      }),
    );
    await settle();

    expect(computeImageCostUsd).toHaveBeenCalledWith({
      provider: "gemini",
      model: "gemini-2.5-flash-image",
      images: 1,
      inputTokens: undefined,
    });
  });

  it("forwards a REPORTED zero prompt as a zero", async () => {
    // The other side of the same distinction: a provider that genuinely billed
    // no prompt tokens must stay priceable.
    emitUsageEvent(
      imageEvent({
        model: "gemini-2.5-flash-image",
        imageCount: 1,
        inputTokens: 0,
        imagePromptTokensReported: true,
        idempotencyKey: "image:priced-6",
      }),
    );
    await settle();

    expect(computeImageCostUsd).toHaveBeenCalledWith({
      provider: "gemini",
      model: "gemini-2.5-flash-image",
      images: 1,
      inputTokens: 0,
    });
  });

  it("keeps the per-image card away from every NON-image operation", async () => {
    // The routing is scoped to `image` in both directions: a token-billed call
    // must never be priced per image.
    emitUsageEvent(
      imageEvent({
        operation: "generate",
        model: "gpt-5.5",
        inputTokens: 100,
        outputTokens: 20,
        imageCount: 3,
        idempotencyKey: "image:priced-4",
      }),
    );
    await settle();

    expect(computeImageCostUsd).not.toHaveBeenCalled();
    expect(computeLlmCostUsd).toHaveBeenCalledTimes(1);
  });
});
