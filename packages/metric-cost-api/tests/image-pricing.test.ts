/**
 * cinatra#2641 — the PER-IMAGE rate card.
 *
 * Image generation's dominant charge is per produced image, not per completion
 * token, so it is priced off its own card. What is pinned here is the card's
 * honesty rather than its arithmetic:
 *
 *   - every rate cites the provider page it was read off, the SERVICE TIER it is
 *     quoted at, and the date it was read — a rate with no provenance is a
 *     number nobody can re-check, and providers publish several tiers per model;
 *   - the rate identity includes the PROVIDER, not just the model name. A model
 *     name is a string an adapter chooses; the provider is the adapter the
 *     metering seam wrapped;
 *   - a provider/model pair with no entry answers `null`, never `0` — `null` is
 *     this module's "unknown" signal and the dashboard's own unknown-cost
 *     surface, while a stored `0` reads as "this image was free";
 *   - EVERY component the provider bills must be reported before anything is
 *     priced. Google charges the prompt as well as the images, so pricing the
 *     images alone would store a partial that renders like a complete total;
 *   - a count that is not a safe integer in range answers `null` too. Those
 *     numbers come from third-party connector code and are MULTIPLIED by a
 *     dollar rate, so every malformed value must degrade to unpriced rather than
 *     to a confidently-stored nonsense price.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
  metadataTable: {},
}));

import { computeImageCostUsd, IMAGE_PRICING } from "../src/pricing";

/** The one provider/model pair the Gemini connector's image path calls today. */
const PROVIDER = "gemini";
const MODEL = "gemini-2.5-flash-image";
const priced = (overrides: Record<string, unknown> = {}) =>
  computeImageCostUsd({
    provider: PROVIDER,
    model: MODEL,
    images: 1,
    inputTokens: 0,
    ...overrides,
  });

describe("the per-image rate card states where each rate came from", () => {
  it("cites a source URL, a service tier and an as-of date for every entry", () => {
    const entries = Object.entries(IMAGE_PRICING).flatMap(([provider, byModel]) =>
      Object.entries(byModel).map(([model, rate]) => [`${provider}/${model}`, rate] as const),
    );
    expect(entries.length).toBeGreaterThan(0);

    for (const [key, rate] of entries) {
      expect(rate.perImageUsd, `${key} must carry a positive rate`).toBeGreaterThan(0);
      expect(rate.source, `${key} must cite the provider page`).toMatch(/^https:\/\//);
      // A provider that publishes Standard / Batch / Flex / Priority rates for
      // the same model makes an untiered number ambiguous.
      expect(rate.tier, `${key} must name the service tier`).toBeTruthy();
      // ISO date, so "when was this checked" has a machine-readable answer.
      expect(rate.asOf, `${key} must state when the rate was read`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    }
  });

  it("carries Google's published Gemini 2.5 Flash Image standard rates", () => {
    // "Image output is priced at $30 per 1,000,000 tokens. Output images up to
    // 1024x1024px consume 1290 tokens and are equivalent to $0.039 per image."
    // Standard-tier input on the same row: "$0.30 (text / image)" per 1M.
    // https://ai.google.dev/gemini-api/docs/pricing
    expect(IMAGE_PRICING[PROVIDER][MODEL]).toMatchObject({
      perImageUsd: 0.039,
      inputPerMillion: 0.3,
      tier: "standard",
      source: "https://ai.google.dev/gemini-api/docs/pricing",
    });
  });

  it("holds no rate for a model whose price depends on output resolution", () => {
    // Gemini 3 Pro Image and Gemini 3.1 Flash Image are priced per resolution
    // tier, and the adapter ABI's image response reports no resolution. Picking
    // a tier would be inventing a number, so those models stay ABSENT and their
    // rows stay unpriced — the honest outcome, and the reason this assertion is
    // a guard rather than a gap.
    expect(IMAGE_PRICING[PROVIDER]["gemini-3-pro-image"]).toBeUndefined();
    expect(IMAGE_PRICING[PROVIDER]["gemini-3.1-flash-image"]).toBeUndefined();
  });
});

describe("computeImageCostUsd", () => {
  it("charges the images AND the prompt the provider bills for", () => {
    // 1 image at $0.039 + 1,000,000 prompt tokens at $0.30/1M.
    expect(priced({ images: 1, inputTokens: 1_000_000 })).toBeCloseTo(0.339, 10);
    // 3 images, no prompt charge to add.
    expect(priced({ images: 3, inputTokens: 0 })).toBeCloseTo(0.117, 10);
    // The realistic shape: one image on a ~1,200-token prompt.
    expect(priced({ images: 1, inputTokens: 1_200 })).toBeCloseTo(0.03936, 10);
  });

  it("answers null when the adapter attested no image count", () => {
    // The state every adapter that has not adopted the ABI's optional image
    // usage is in. It must land on the counted-but-unpriced row, unchanged.
    expect(priced({ images: undefined })).toBeNull();
    expect(priced({ images: null })).toBeNull();
  });

  it("answers null when a BILLED component went unreported", () => {
    // This entry declares an input rate, so the images alone are not the bill.
    // Pricing them would store a number short by the whole prompt charge, and a
    // partial in `cost_usd` renders exactly like a complete one.
    expect(priced({ inputTokens: undefined })).toBeNull();
    expect(priced({ inputTokens: null })).toBeNull();
    expect(priced({ inputTokens: -1 })).toBeNull();
    expect(priced({ inputTokens: 1.5 })).toBeNull();
    expect(priced({ inputTokens: NaN })).toBeNull();
  });

  it("refuses another provider claiming this model's NAME", () => {
    // The rate identity is (provider, model). A model name is a string an
    // adapter chooses; without the provider in the key, any connector could
    // borrow Google's rate by naming Google's model.
    expect(priced({ provider: "openai" })).toBeNull();
    expect(priced({ provider: "anthropic" })).toBeNull();
    expect(priced({ provider: null })).toBeNull();
    expect(priced({ provider: "" })).toBeNull();
  });

  it("answers null for a model with no per-image rate", () => {
    // Including the "unknown" the seam writes when no model was attested, and a
    // model the per-token COMPLETION card knows — knowing a completion rate says
    // nothing about what an image costs.
    expect(priced({ model: "unknown" })).toBeNull();
    expect(priced({ model: "gpt-5.5" })).toBeNull();
    expect(priced({ model: null })).toBeNull();
    expect(priced({ model: "" })).toBeNull();
  });

  it("answers null for a count that cannot be multiplied by money", () => {
    for (const images of [0, -1, 1.5, NaN, Infinity, -Infinity, 2 ** 53]) {
      expect(priced({ images }), `images=${String(images)}`).toBeNull();
    }
    // A stringified count is a connector bug, not a quantity.
    expect(priced({ images: "2" })).toBeNull();
  });

  it("does not resolve inherited Object.prototype keys as rates", () => {
    // A provider or model literally named "constructor" would otherwise reach a
    // prototype member and be treated as a rate table / a rate.
    expect(priced({ model: "constructor" })).toBeNull();
    expect(priced({ model: "toString" })).toBeNull();
    expect(priced({ provider: "constructor" })).toBeNull();
    expect(priced({ provider: "toString" })).toBeNull();
  });
});
