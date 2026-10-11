// @vitest-environment jsdom
/**
 * THE SETTLED MARKER, DRAWN (cinatra#2934, fix leg 12 — the maintainer's
 * finding 6).
 *
 * THE MEASUREMENT. The dev-boot proof round of 2026-09-04 took a real run
 * through its shipped decision bar and read, on both surfaces and in both
 * palettes, a red circled-X card:
 *
 *   "Rejected by Proof Admin — The gate is resolved and the reviewed work has
 *    been turned back."
 *
 * THE DRAWING. Lifecycle cards §XIII.1 gives the settled state ONE reading and
 * says so outright: "Continued is the only settled reading; there is no second
 * status after it." What it draws below the whole card is a marker — the pill
 * "Continued", and beside it "Decided on the revision above." Artifact review
 * §VI adds the other half: the review "draws no card that names who requested
 * changes".
 *
 * So: one marker, the same for every disposition, naming nobody, and no
 * per-outcome status glyph or tone that would read as a second status. The
 * disposition survives where it belongs — the run's own rows, and this
 * element's `data-review-outcome` attribute, which is a record and not a
 * reading.
 */
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ReviewGateSettled } from "../review-gate-states";

const OUTCOMES = ["approved", "rejected", "changes_requested"] as const;

afterEach(() => cleanup());

function settled(outcome: (typeof OUTCOMES)[number]) {
  const { container } = render(<ReviewGateSettled outcome={outcome} />);
  return container.querySelector('[data-conformance-id="review-gate-settled"]')!;
}

describe("the drawn settled marker", () => {
  it("reads the drawing's words on every disposition", () => {
    for (const outcome of OUTCOMES) {
      const marker = settled(outcome);
      expect(marker).not.toBeNull();
      expect(marker.textContent).toContain("Continued");
      expect(marker.textContent).toContain("Decided on the revision above.");
      cleanup();
    }
  });

  it("draws the SAME marker whatever was decided — no second status", () => {
    const drawn: string[] = [];
    for (const outcome of OUTCOMES) {
      // The disposition record is deliberately excluded from the comparison:
      // it is a record, not a reading.
      const marker = settled(outcome);
      marker.removeAttribute("data-review-outcome");
      drawn.push(marker.outerHTML);
      cleanup();
    }
    expect(new Set(drawn).size).toBe(1);
  });

  it("keeps the disposition as a RECORD on the element", () => {
    for (const outcome of OUTCOMES) {
      expect(settled(outcome).getAttribute("data-review-outcome")).toBe(outcome);
      cleanup();
    }
  });

  it("names no person and draws none of the readings the round measured", () => {
    for (const outcome of OUTCOMES) {
      const text = settled(outcome).textContent ?? "";
      expect(text).not.toContain("Proof Admin");
      expect(text).not.toMatch(/ by /);
      expect(text).not.toContain("Approved");
      expect(text).not.toContain("Rejected");
      expect(text).not.toContain("Changes requested");
      expect(text).not.toContain("turned back");
      cleanup();
    }
  });
});
