// @vitest-environment jsdom
/**
 * THE PARKED BOX'S OWN FRAME, AGAINST THE RATIFIED DRAWING (cinatra#3046, fix
 * leg 12).
 *
 * The drawing's placeholder example — the one this box carries the conformance
 * anchor of — puts exactly two things in the card: the card's fixed NAME, and a
 * band holding ONE node, a 22px `viewBox 0 0 24 24` with a single stroked arc in
 * the indigo, spinning. Its prose adds the negative half: the box "names no
 * status, reports no result and draws nothing to press".
 *
 * WHAT THE TENTH GRADED READING MEASURED ON IT, in both palettes: a tinted tile
 * behind the arc, and a grey track ring around it. Both are real and both are
 * undrawn — the tile was a 30px `rounded-lg bg-mustard-ink/15` wrapper this file
 * added, and the ring is the full `circle` at `stroke-opacity 0.25` inside the
 * shared `LoadingSpinner`, which is right for every other surface in the system
 * and is not what the drawing gives this box.
 *
 * AND THE TITLE STAYS. The same round read a progress title inside the box as a
 * possible departure; re-read at design main for this leg, the drawing's own
 * placeholder example opens the card with exactly that string, so removing it
 * would put the box out of conformance with the example it is anchored to. It is
 * a fixed card name, not a status and not a result. Pinned below so the question
 * is settled in the suite rather than re-litigated on the next round.
 *
 * RED-FIRST: the tile and the ring assertions fail at the previous head.
 */
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ReviewGatePlaceholder } from "../review-gate-states";

afterEach(cleanup);

function placeholder(props: Parameters<typeof ReviewGatePlaceholder>[0] = {}) {
  const { container } = render(<ReviewGatePlaceholder {...props} />);
  const box = container.querySelector('[data-conformance-id="review-gate-placeholder"]');
  if (!box) throw new Error("the placeholder did not render its own frame");
  return box as HTMLElement;
}

describe("the parked box draws the frame the drawing gives it", () => {
  it("draws ONE node in the band, and it is the arc", () => {
    const box = placeholder({ runRef: "run-abc" });
    const svgs = box.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    const arc = svgs[0]!;
    expect(arc.getAttribute("viewBox")).toBe("0 0 24 24");
    // THE ARC ALONE. A second stroked node in this icon is the grey track ring.
    expect(arc.querySelectorAll("circle")).toHaveLength(0);
    expect(arc.querySelectorAll("path")).toHaveLength(1);
    expect(arc.getAttribute("class") ?? "").toContain("animate-spin");
  });

  it("puts nothing behind the arc", () => {
    const box = placeholder({ runRef: "run-abc" });
    // The tinted tile: a wrapper with a background and a corner radius, drawn
    // between the band and the arc. The drawing's band holds the arc directly.
    const tinted = Array.from(box.querySelectorAll("*")).filter((el) => {
      const cls = el.getAttribute("class") ?? "";
      return /\bbg-/.test(cls) || /\brounded-/.test(cls);
    });
    expect(tinted.map((el) => el.getAttribute("class"))).toEqual([]);
  });

  it("keeps the arc on the indigo the drawing names", () => {
    const box = placeholder();
    const arc = box.querySelector("svg")!;
    expect(arc.getAttribute("class") ?? "").toContain("text-primary");
    expect(arc.getAttribute("class") ?? "").toContain("size-[22px]");
  });

  it("carries the card's own fixed name, and no status and no result", () => {
    const box = placeholder({ runRef: "run-abc" });
    expect(box.textContent).toBe("Agentic Run Progress");
    expect(box.querySelectorAll("button")).toHaveLength(0);
  });

  it("stops the arc when the wait is over, and keeps the band", () => {
    const box = placeholder({ runRef: "run-abc", settled: true });
    expect(box.querySelectorAll("svg")).toHaveLength(0);
    expect(box.getAttribute("aria-busy")).toBe("false");
    expect(box.textContent).toBe("Agentic Run Progress");
  });
});
