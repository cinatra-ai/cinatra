// @vitest-environment jsdom
//
// THE WORKING PLACEHOLDER, DRAWN AS THE RATIFIED DRAWING DRAWS IT
// (cinatra#3051, the eighth proof round's graded reading).
//
// WHY THIS SUITE EXISTS. The placeholder is the card a reader looks at for the
// whole time a run works, on the run page and inside a conversation column
// alike, and the eighth proof round graded it against the ratified drawing and
// failed it in both palettes: no title, an ink-toned spinner over a grey track
// ring in a small top-left tile, and a nested five-bar skeleton panel that the
// drawing does not draw at all. None of those three is readable from source, so
// they are pinned here as DOM facts.
//
// THE DRAWING'S OWN SENTENCES, quoted rather than paraphrased — Agent run &
// review, "the run progress card":
//
//   "While the run works, the detail carries a placeholder. A run that will ask
//    for a review carries, in the run detail, the run progress card — and while
//    the run is working that card is a placeholder for the review screen: the
//    card frame, and a spinning icon, the indigo arc of Components § Skeleton /
//    Spinner. It names no status, reports no result and draws nothing to press."
//
//   "It is replaced, in place, when the output is generated. The placeholder
//    becomes the Review requested gate above — the same detail, under the same
//    rail. It happens on its own: there is nothing for the reader to open or
//    press to bring it."
//
// AND ITS OWN DRAWN ANATOMY, at the anchors `run-progress-placeholder` (Agent
// run & review) and `run-progress-placeholder-in-thread` (Lifecycle cards § I) —
// the two surfaces draw the SAME card, character for character:
//
//   the card, then a title in the sans face at 14px, weight 700, in ink,
//   reading "Agentic Run Progress";
//   then one arc, centred (`place-items:center`), 22px, stroked in the indigo
//   accent, spinning 1s linear, on the path `M21 12a9 9 0 1 1-6.219-8.56`;
//   and nothing else — no ring behind the arc, no bar, no second panel.
//
// Components § Skeleton / Spinner says the same in one line: "Spinner: indigo
// arc · 1s linear". An arc is the whole mark; a track ring behind it is a second
// mark the drawing does not carry.
//
// THE COMPONENT IS THE HOME. Every host mounts this one component — the run
// page's panel, the setup run page, the orchestrator stepper's terminal card and
// the conversation column inside the site widget — each inside its own card
// frame with no title of its own. So the title belongs to the placeholder, and
// fixing it here fixes it on every host at once.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReviewGatePlaceholder } from "../review-gate-states";

const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';

/** The drawing's arc, verbatim. */
const DRAWN_ARC_PATH = "M21 12a9 9 0 1 1-6.219-8.56";

afterEach(() => {
  cleanup();
});

describe("the working placeholder draws the ratified drawing's own reading", () => {
  it("names the card: 'Agentic Run Progress', in the sans face at 14px / 700 / ink", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const root = container.querySelector(PLACEHOLDER);
    expect(root).not.toBeNull();

    const title = root!.querySelector('[data-placeholder-title="agentic-run-progress"]');
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe("Agentic Run Progress");

    // 14px sans in ink, weight 700 — the drawing's own three declarations,
    // through the shipped tokens (`text-sm` is the 14px step, `text-foreground`
    // is ink, `font-bold` is 700).
    const cls = title!.getAttribute("class") ?? "";
    expect(cls).toContain("font-sans");
    expect(cls).toContain("text-sm");
    expect(cls).toContain("font-bold");
    expect(cls).toContain("text-foreground");
  });

  it("draws ONE centred indigo arc, spinning, with no ring behind it", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const root = container.querySelector(PLACEHOLDER)!;

    const svgs = root.querySelectorAll("svg");
    expect(svgs.length).toBe(1);
    const arc = svgs[0]!;

    // The arc itself — the drawing's path, and no second mark.
    const paths = arc.querySelectorAll("path");
    expect(paths.length).toBe(1);
    expect(paths[0]!.getAttribute("d")).toBe(DRAWN_ARC_PATH);

    // "the indigo arc of Components § Skeleton / Spinner" — an ARC, so no track
    // ring is drawn behind it. This is the mark the eighth round read as "the
    // ink token over an unspecified grey track ring".
    expect(arc.querySelectorAll("circle").length).toBe(0);

    // Indigo, and spinning 1s linear — the accent token, not the ink or mustard
    // one the placeholder used to wear.
    const arcCls = arc.getAttribute("class") ?? "";
    expect(arcCls).toContain("text-primary");
    expect(arcCls).toContain("animate-spin");
    expect(arcCls).not.toContain("mustard");

    // Centred in the card, not a small mark in a top-left tile.
    const well = arc.parentElement!;
    const wellCls = well.getAttribute("class") ?? "";
    expect(wellCls).toContain("grid");
    expect(wellCls).toContain("place-items-center");
  });

  it("draws nothing else: no skeleton bars, no nested panel, nothing to press", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const root = container.querySelector(PLACEHOLDER)!;

    // The five-bar skeleton the eighth round found nested inside the card. The
    // drawing pairs no skeleton with this spinner — §IV's loading skeleton is a
    // DIFFERENT state, drawn while the host prepares a target that exists.
    expect(root.querySelector('[data-conformance-id="review-gate-loading"]')).toBeNull();
    expect(root.querySelectorAll(".bg-surface-muted").length).toBe(0);

    // "draws nothing to press", "there is nothing for the reader to open or
    // press to bring it".
    expect(root.querySelectorAll("button, a, input, [role='button']").length).toBe(0);

    // "It names no status, reports no result" — the title is the card's name,
    // and it is the only text on the card.
    expect(root.textContent).toBe("Agentic Run Progress");
  });

  it("stays a busy region for a reader who cannot see the spin", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const root = container.querySelector(PLACEHOLDER)!;
    expect(root.getAttribute("role")).toBe("status");
    expect(root.getAttribute("aria-busy")).toBe("true");
  });
});
