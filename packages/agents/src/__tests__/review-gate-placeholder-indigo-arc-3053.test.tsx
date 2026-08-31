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

/** The wrapper the shared spinner takes its `currentColor` from. */
function arcWrapper(root: HTMLElement): HTMLElement {
  const placeholder = root.querySelector<HTMLElement>(
    '[data-conformance-id="review-gate-placeholder"]',
  );
  expect(placeholder).not.toBeNull();
  const svg = placeholder!.querySelector("svg");
  expect(svg).not.toBeNull();
  const wrapper = svg!.parentElement;
  expect(wrapper).not.toBeNull();
  return wrapper as HTMLElement;
}

describe("the placeholder's spinning icon", () => {
  it("is drawn with a colour token the theme actually registers", () => {
    const { container } = render(<ReviewGatePlaceholder />);

    const classes = arcWrapper(container).className.split(/\s+/);
    const colourUtility = classes.find((c) => c.startsWith("text-"));
    expect(colourUtility).toBeDefined();
    const token = colourUtility!.replace(/^text-/, "").replace(/\/.*$/, "");
    expect(registersColourToken(token)).toBe(true);
  });

  it("takes the indigo arc's own token, not the inherited foreground", () => {
    const { container } = render(<ReviewGatePlaceholder />);

    const classes = arcWrapper(container).className;
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
    // Kept as a statement of the CAUSE: nothing registers this, so every
    // utility built on it emits no rule. It is the reason the arc took
    // `currentColor` rather than a colour anybody chose.
    expect(registersColourToken("mustard-ink")).toBe(false);
  });
});
