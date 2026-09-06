// @vitest-environment jsdom
/**
 * THE SETTLED MARKER IS THE DRAWN ROW, AND ITS SENTENCE IS THE DRAWN SENTENCE
 * (cinatra#3007, fix leg 17; cinatra#3293, #3294).
 *
 * The thirteenth graded reading measured the marker below the decided display in
 * both palettes and found two departures of the same drawing paragraph:
 *
 *   · its sentence is not the drawn one;
 *   · it is composed as a centred double-check glyph over two centred lines,
 *     where the drawing gives a small pill followed by the sentence, on ONE row,
 *     left-aligned with the display.
 *
 * The drawing's own markup for this marker is a flex row —
 * `display:flex; flex-wrap:wrap; align-items:center; gap:8px;
 *  border:1px solid var(--line); border-radius:8px; background:var(--surface);
 *  padding:9px 12px` — holding a pill (`border-radius:9999px`, a 7px dot, 12px
 * semibold text) and then a 12px `var(--muted)` sentence. Every drawn instance
 * of it opens with the same words: "Decided on the revision above."; what
 * follows in a drawn example is the DISPLAY's own continuation ("These are the
 * words that will be sent", "The dashboard is live from here"), which belongs to
 * the artifact type's display and is never the host's to write.
 *
 * The ACTOR on the pill is a departure of its own, already recorded against this
 * branch and deliberately untouched here.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/review-settled-marker-row-3293.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ReviewGateSettled } from "../review-gate-states";
import type { ReviewSettledOutcome } from "@/lib/artifacts/review-surface-model";

afterEach(() => cleanup());

const OUTCOMES: ReviewSettledOutcome[] = ["approved", "rejected", "changes_requested"];

/** The drawing's sentence, as every drawn settled marker opens it. */
const THE_DRAWN_SENTENCE = "Decided on the revision above.";

function marker(outcome: ReviewSettledOutcome, decidedByName?: string): HTMLElement {
  const { container } = render(
    <ReviewGateSettled outcome={outcome} decidedByName={decidedByName} />,
  );
  const node = container.querySelector<HTMLElement>(
    '[data-conformance-id="review-gate-settled"]',
  );
  if (node === null) throw new Error("no settled marker was drawn");
  return node;
}

describe("the settled marker", () => {
  it.each(OUTCOMES)("%s — its sentence is the drawing's sentence", (outcome) => {
    const node = marker(outcome, "Dana Okonkwo");
    const sentence = node.querySelector(
      '[data-conformance-id="review-gate-settled-sentence"]',
    );
    expect(sentence, "the marker draws no sentence node").not.toBeNull();
    expect((sentence?.textContent ?? "").trim()).toBe(THE_DRAWN_SENTENCE);
    // And no sentence this surface invented for itself survives anywhere in it.
    expect(node.textContent ?? "").not.toMatch(/The gate is resolved/i);
  });

  it.each(OUTCOMES)(
    "%s — it is the drawn pill-plus-sentence row, left-aligned, not a centred glyph",
    (outcome) => {
      const node = marker(outcome, "Dana Okonkwo");
      const cls = node.className;
      // ONE ROW: a flex row that wraps, items centred on the cross axis.
      expect(cls, "the marker is not a row").toMatch(/(?:^|\s)flex(?:\s|$)/);
      expect(cls).toMatch(/flex-wrap/);
      expect(cls).toMatch(/items-center/);
      // LEFT-ALIGNED WITH THE DISPLAY — never the centred treatment.
      expect(cls, "the marker still centres its text").not.toMatch(/text-center/);
      // THE PILL, with the drawn dot in it.
      const pill = node.querySelector<HTMLElement>(
        '[data-conformance-id="review-gate-settled-pill"]',
      );
      expect(pill, "the marker draws no pill").not.toBeNull();
      expect(pill?.className ?? "").toMatch(/rounded-full/);
      expect(
        pill?.querySelector("span.rounded-full"),
        "the pill carries no dot",
      ).not.toBeNull();
      // AND NO CENTRED GLYPH TILE. The old treatment was a 36px tile,
      // `mx-auto ... grid ... place-items-center`, with an icon in it.
      expect(node.querySelector(".mx-auto"), "a centred tile is still drawn").toBeNull();
      expect(node.querySelectorAll("svg").length, "a glyph is still drawn").toBe(0);
    },
  );

  it("keeps the outcome readable on its own attribute, three ways", () => {
    for (const outcome of OUTCOMES) {
      const node = marker(outcome);
      expect(node.getAttribute("data-review-outcome")).toBe(outcome);
      cleanup();
    }
  });
});
