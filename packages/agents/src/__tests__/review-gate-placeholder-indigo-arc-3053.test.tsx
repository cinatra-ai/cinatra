// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// THE PLACEHOLDER'S SPINNING ICON IS THE INDIGO ARC (cinatra#3044, the eighth
// set's third defect).
// ---------------------------------------------------------------------------
// The ratified drawing, §II, on the reading that stands in the slot before the
// review card fills it:
//
//   "Before the card, the slot holds its placeholder. A run that will ask for a
//    review carries, in the slot the review card will fill, the run progress
//    card — and while the run is working that card is a placeholder for the
//    review screen: the card frame, and a spinning icon, the indigo arc of
//    Components § Skeleton / Spinner. It names no status, reports no result and
//    draws nothing to press."
//
// WHAT WAS MEASURED. The arc was not indigo in either theme: light
// `rgb(21,33,58)`, dark `rgb(248,250,252)`. Those are not a colour anybody
// chose — they are the INHERITED foreground, which is what a Tailwind colour
// utility falls back to when its token was never registered. The wrapper the
// spinner spins inside carried `text-mustard-ink`, and no `--color-mustard-ink`
// is registered in the theme block, so the utility emitted no rule at all and
// the arc simply took `currentColor`.
//
// So this file pins two things that have to hold together: the arc is drawn with
// a REGISTERED token, and that token is the indigo one.
//
// AND `--color-mustard-ink` IS REGISTERED NOW. The theme block binds it for the
// warm tint the same wrapper carries behind the arc (`bg-mustard-ink/15`), so
// the ABSENCE is the history of the defect, not the present state of the theme.
// What still has to hold is the invariant that absence exposed, and that is
// what this file pins: the arc's own COLOUR utility is the registered indigo,
// and the mustard token may reach this wrapper only as a background, never as
// the arc's text colour.
//
// THE DARK READING IS THE ITEM ALREADY TRACKED ON THIS PULL REQUEST. The
// registered indigo token resolves to the drawing's `#364e81` in light and to
// the application's near-white dark primary in dark — which is exactly the
// dark-theme token deviation this pull request already records for the chosen
// row and the floor. Folding the arc onto the same token folds it into that one
// item rather than opening a second: whatever settles the dark token settles the
// arc with it, in one place.
//
// Run:
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/review-gate-placeholder-indigo-arc-3053.test.tsx
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ReviewGatePlaceholder } from "../review-gate-states";

afterEach(cleanup);

const GLOBALS = readFileSync(
  path.resolve(__dirname, "../../../../src/app/globals.css"),
  "utf8",
);

/** The `@theme inline` block is where a `--color-*` utility becomes real. */
function registersColourToken(name: string): boolean {
  return new RegExp(`--color-${name}\\s*:`).test(GLOBALS);
}

/** The arc's own class list. The drawn placeholder gives the arc no wrapper
 *  tile to inherit a colour from, so the token is read off the arc itself. */
function arcClasses(root: HTMLElement): string {
  const placeholder = root.querySelector<HTMLElement>(
    '[data-conformance-id="review-gate-placeholder"]',
  );
  expect(placeholder).not.toBeNull();
  const svg = placeholder!.querySelector("svg");
  expect(svg).not.toBeNull();
  return svg!.getAttribute("class") ?? "";
}

describe("the placeholder's spinning icon", () => {
  it("is drawn with a colour token the theme actually registers", () => {
    const { container } = render(<ReviewGatePlaceholder />);

    const classes = arcClasses(container).split(/\s+/);
    const colourUtility = classes.find((c) => c.startsWith("text-"));
    expect(colourUtility).toBeDefined();
    const token = colourUtility!.replace(/^text-/, "").replace(/\/.*$/, "");
    expect(registersColourToken(token)).toBe(true);
  });

  it("takes the indigo arc's own token, not the inherited foreground", () => {
    const { container } = render(<ReviewGatePlaceholder />);

    const classes = arcClasses(container);
    expect(classes).toMatch(/\btext-primary\b/);
    // The unregistered utility that painted the measured foreground.
    expect(classes).not.toMatch(/\btext-mustard-ink\b/);
  });
});

describe("the token the arc now takes", () => {
  it("is the drawing's indigo in the light theme", () => {
    expect(registersColourToken("primary")).toBe(true);
    // The application's own indigo, the one the drawing fixes for the chosen
    // row's edge and this arc alike.
    expect(GLOBALS).toMatch(/--primary:\s*#364e81/i);
  });

  it("names the token whose absence produced the measured foreground", () => {
    // THE CAUSE, READ ON THE TREE AS IT NOW STANDS. When the foreground was
    // measured, nothing registered `--color-mustard-ink`, so every utility
    // built on it emitted no rule and the arc took `currentColor` rather than
    // a colour anybody chose. The `@theme inline` block binds that token now,
    // for the warm tint this same wrapper carries, so the absence is history:
    // pinning it as present state would be asking for the tint to be taken
    // away again.
    expect(registersColourToken("mustard-ink")).toBe(true);
    expect(GLOBALS).toMatch(/--color-mustard-ink:\s*var\(--mustard-ink\)/);

    // What the absence exposed, and what still has to hold: the arc's own
    // colour utility is never built on the mustard token, so no later tint can
    // take the arc back to `currentColor`.
    //
    // RETIRED HERE, BY THE DRAWING'S OWN SENTENCE: this suite used to also pin
    // that the mustard token reached the arc's WRAPPER as a background. The
    // ratified `app-lifecycle-cards` names the placeholder's anatomy in full and
    // it has no such wrapper in it — "while the run is working that card is a
    // placeholder for the review screen: the card frame, and a spinning icon,
    // the indigo arc of Components § Skeleton / Spinner". The card frame and the
    // arc are the whole of it, so the coloured tile that assertion measured is
    // not drawn at all, and a pin on its background colour would pin a shape the
    // drawing does not have. What that assertion was FOR — the arc's own colour
    // can never fall back to `currentColor` — is pinned above and below it, on
    // the arc itself, where the drawing puts the colour.
    const { container } = render(<ReviewGatePlaceholder />);
    const classes = arcClasses(container).split(/\s+/);
    expect(classes.some((c) => c.startsWith("text-mustard-ink"))).toBe(false);
    expect(classes).toContain("text-primary");
  });
});

// ---------------------------------------------------------------------------
// WHAT THE PLACEHOLDER IS ALLOWED TO DRAW
// ---------------------------------------------------------------------------
//
// The ratified drawing's section II, verbatim:
//
//   "Before the card, the slot holds its placeholder. A run that will ask for a
//    review carries, in the slot the review card will fill, the run progress
//    card - and while the run is working that card is a placeholder for the
//    review screen: the card frame, and a spinning icon, the indigo arc of
//    Components section Skeleton / Spinner. It names no status, reports no
//    result and draws nothing to press."
//
// TWO THINGS, and the sentence enumerates them: the card frame, and a spinning
// icon. The drawing's own placeholder example draws exactly that - the card box
// with one centred arc in it, under the card's own name - and nothing more. A ninth graded set measured a
// block of bars beside the arc, two in a header band over three in a body band,
// which is a third thing no sentence and no drawing gives.

describe("the placeholder draws the card frame and a spinning icon, and nothing else", () => {
  it("carries no skeleton bars beside the arc", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const placeholder = container.querySelector<HTMLElement>(
      '[data-conformance-id="review-gate-placeholder"]',
    );
    expect(placeholder).not.toBeNull();
    // The bar motif is the gate's own LOADING state, drawn in the target slots
    // while the host prepares them. It is not part of this placeholder.
    expect(
      placeholder!.querySelector('[data-conformance-id="review-gate-loading"]'),
    ).toBeNull();
    // And no bar by any other route: a rounded muted block with a bar's height.
    expect(placeholder!.querySelectorAll("div.rounded.bg-surface-muted").length).toBe(0);
  });

  it("draws exactly one graphic - the arc", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const placeholder = container.querySelector<HTMLElement>(
      '[data-conformance-id="review-gate-placeholder"]',
    );
    expect(placeholder!.querySelectorAll("svg").length).toBe(1);
    // "It names no status, reports no result and draws nothing to press."
    expect(placeholder!.querySelectorAll("button").length).toBe(0);
    // THE CARD'S OWN NAME IS NOT ONE OF THOSE THREE (cinatra#3044, the eleventh
    // set). This line read the sentence above as "no text at all". The same
    // section's drawn placeholder example is markup, and its first child is the
    // heading "Agentic Run Progress" — so the sentence's three clauses are about
    // a STATUS word, a RESULT and a CONTROL, none of which a fixed card name is.
    // What the placeholder must never carry is a run's state word, and that is
    // what is pinned here now.
    expect(placeholder!.textContent?.trim()).toBe("Agentic Run Progress");
    expect(placeholder!.textContent).not.toMatch(
      /queued|running|working|waiting|pending|complete|failed|done/i,
    );
  });
});
