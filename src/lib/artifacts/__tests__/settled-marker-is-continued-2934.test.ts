// THE SETTLED READING IS THE DRAWING'S ONE MARKER (cinatra#2934, fix leg 12 —
// the maintainer's finding 6, and the dev-boot proof round of 2026-09-04).
//
// The round measured, after a decision, a red circled-X card reading
// "Rejected by Proof Admin — The gate is resolved and the reviewed work has
// been turned back." on both surfaces and both palettes. Two ratified sentences
// forbid it.
//
//   Lifecycle cards §XIII.1: "Continued is the only settled reading; there is
//   no second status after it." — and the marker it draws reads "Continued"
//   over "Decided on the revision above."
//
//   Artifact review §VI: the review "draws no card that names who requested
//   changes: there is no 'Changes requested by …' card on this surface".
//
// So the settled copy is ONE reading for every disposition and it names no
// person. The disposition is not lost — it stays a record on the run's own
// rows, and on this card's own `data-review-outcome` attribute, which is where
// a fact about what was decided belongs. It is not a card.

import { describe, expect, it } from "vitest";

import { reviewSettledCopy, REVIEW_SETTLED_MARKER } from "../review-surface-model";
import { LIFECYCLE_SETTLED_OUTCOMES } from "@cinatra-ai/agent-ui-protocol/renderable-views";

/** The drawing's own words, verbatim from specs/app-lifecycle-cards.html §XIII.1. */
const MARKER = { title: "Continued", body: "Decided on the revision above." };

describe("the settled reading — one marker, in the drawing's words", () => {
  it('reads "Continued / Decided on the revision above." for EVERY disposition', () => {
    for (const outcome of LIFECYCLE_SETTLED_OUTCOMES) {
      expect(reviewSettledCopy(outcome)).toEqual(MARKER);
    }
  });

  it("there is no second status after it — the three dispositions read the same", () => {
    const readings = [...LIFECYCLE_SETTLED_OUTCOMES].map((o) =>
      JSON.stringify(reviewSettledCopy(o)),
    );
    expect(new Set(readings).size).toBe(1);
  });

  it("takes NO decider at all — a caller cannot offer one to name", () => {
    // §VI is not satisfied by a copy that merely declines to use a name it was
    // handed; the surface has no place to put one. The parameter is gone, so
    // the only argument this reading takes is the disposition it records.
    expect(reviewSettledCopy.length).toBe(1);
    // Arity alone would not settle it — an optional or rest parameter keeps
    // `.length` at 1 — so the reading is also called WITH a name forced past the
    // signature, and must be the same two lines.
    const forced = (reviewSettledCopy as unknown as (o: string, n?: string) => {
      title: string;
      body: string;
    })("approved", "Proof Admin");
    expect(forced).toEqual(REVIEW_SETTLED_MARKER);
  });

  it("drops the readings the round measured — no Approved / Rejected / Changes requested card", () => {
    for (const outcome of LIFECYCLE_SETTLED_OUTCOMES) {
      const copy = reviewSettledCopy(outcome);
      expect(copy.title).not.toContain("Approved");
      expect(copy.title).not.toContain("Rejected");
      expect(copy.title).not.toContain("Changes requested");
      expect(copy.body).not.toContain("turned back");
      expect(copy.body).not.toContain("released to continue");
    }
  });
});
