// @vitest-environment jsdom
//
// Card — the graded checklist for the components drawing's "Card" section
// (cinatra#3189, shared-primitives wave, leg 2).
//
//   pnpm exec vitest run src/components/ui/__tests__/card-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "surface (default)"
//   "surface-strong (interactive)"
//   "1px line border"
//   "10–12px radius"
//   "Non-interactive cards use `--surface`. Clickable cards (agent tiles, run
//    rows, popovers, anything with hover or focus) use `--surface-strong` per
//    rule #8."
//
// and the section's own example, which the drawing renders beside those lines:
//
//   "Hover lifts it 1px."
//
// The design-system rule the ground clause cites, quoted verbatim from the
// "Rules of the road" list:
//
//   "8. White means interactive — Pure-white `--surface-strong` (`#FFFFFF`) is
//    reserved for elements the user actually touches — text inputs, clickable
//    cards, popovers, dropdown menus. Everything else (presentation cards,
//    panels, stat tiles, palette swatches) sits on the warm-cream `--surface`
//    (`#F7F7F3`)."
//
// WHAT THIS FILE GRADES, AND WHAT IT CANNOT. jsdom applies no stylesheet, so a
// computed corner cannot be read here. The corner's LIVE value is graded in
// both palettes on the real boot, in
// tests/e2e/design/conformance/primitive-wave-leg1.spec.ts. What this file
// grades is the pair of things a browser reading cannot state on its own: the
// RECIPE the product spells, and the ARITHMETIC of that recipe against the
// palette declarations in src/app/globals.css. The second is what would catch a
// later re-ordering of those declarations — the corner would leave the band
// with nothing that draws a card having changed at all.
//
// THE CORNER CLAUSE, AND WHY IT IS NOT THE SHARED `xl` STEP. The card cuts its
// corner on `rounded-xl`, which is `calc(var(--radius) + 4px)`. `--radius` is
// declared three times in this product: 0.625rem on the bare `:root`, 0.5rem on
// the light palette the app boots in (`.cinatra`), and 0.625rem again on
// `.dark`. The `xl` step therefore resolves to 12px in the light palette — the
// top of the band, conforming — and to 14px in the dark palette, OUTSIDE it.
// The first grading of this row measured the bare defaults and called the light
// value a departure; the correction re-measured under the app's own palette and
// restored the corner. Both readings were taken in ONE palette, and the dark one
// is where the clause actually fails.
//
// WHERE THE REPAIR IS SPELLED, AND WHY THERE. The recipe is
// `calc(var(--radius) + 2px)` — two steps above the radius base, which lands
// inside the band under all three declarations (12px, 10px, 12px) — and it is
// declared as a scope on the card's DOM seam at the end of src/app/globals.css,
// not as a class on `card.tsx`.
//
// `card.tsx` is a design-registry primitive vendored verbatim, modulo import
// rewriting, into extension packages held in their own repositories, and
// scripts/extensions/vendor-extension-primitives.mjs is a provenance gate over
// all 107 of those copies: it fails the moment the host source and a vendored
// copy differ by a byte. Spelling the corner in the primitive's class string
// drifts six extension repositories at once — twenty-connector,
// tailscale-connector, nango-connector, list-curator-agent,
// blog-linkedin-publish-agent and blog-wordpress-publish-agent — and cannot go
// green until every one of them has re-vendored and the pins in
// cinatra-dev-extensions.lock.json have been raised to the re-vendored commits.
// That is a cross-repository transaction, and it is the SAME mechanism that
// keeps the badge's "line border" clause a recorded departure on this leg. A
// rule on the seam reaches the host copy and every vendored copy alike, by
// containment, with no file the provenance gate reads changed at all — so the
// clause lands here rather than being recorded a second time.
//
// Moving the shared `xl` step instead was the other candidate and was not taken:
// `empty`, `command` and the inset sidebar spell that step too, and this wave
// has graded none of their corners.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

afterEach(cleanup);

/** The band the section states, in px, inclusive at both ends. */
const BAND = { min: 10, max: 12 };

/** The corner recipe the product is asked to spell, once. */
const CORNER = "calc(var(--radius) + 2px)";

function renderCard(className?: string) {
  const { container } = render(
    <Card className={className}>
      <CardHeader>
        <CardTitle>Run 4821</CardTitle>
      </CardHeader>
      <CardContent>Step 3 of 7.</CardContent>
      <CardFooter>Two approvals pending.</CardFooter>
    </Card>,
  );
  return container;
}

function renderInteractive(): HTMLElement {
  return render(<Card interactive>Agent tile</Card>).container;
}

function slot(container: HTMLElement, name: string): HTMLElement {
  const el = container.querySelector(`[data-slot="${name}"]`);
  expect(el, `no [data-slot="${name}"] rendered`).not.toBeNull();
  return el as HTMLElement;
}

// Resolved from the vitest root (the repository root), not from
// import.meta.url: the file is transformed, so its module URL is not a file
// URL and cannot be turned into a path.
const GLOBALS = join(process.cwd(), "src/app/globals.css");

function globals(): string {
  return readFileSync(GLOBALS, "utf8");
}

/**
 * The declaration block for one selector, taken from globals.css as the
 * cascade sees it: the LAST `--radius` inside the block wins, which is not
 * always the first one written there.
 */
function radiusPxOf(selector: string): number {
  const lines = globals().split("\n");
  const start = lines.findIndex((line) => line.trim() === `${selector} {`);
  expect(start, `${selector} block not found in globals.css`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && line === "}");
  expect(end, `${selector} block is never closed in globals.css`).toBeGreaterThan(start);
  const declarations = [
    ...lines
      .slice(start, end)
      .join("\n")
      .matchAll(/--radius:\s*([\d.]+)(rem|px)\s*;/g),
  ];
  expect(
    declarations.length,
    `${selector} declares no --radius in globals.css`,
  ).toBeGreaterThan(0);
  const [, value, unit] = declarations[declarations.length - 1];
  return unit === "rem" ? Number(value) * 16 : Number(value);
}

/**
 * The brace depth a selector's block opens at, counted over the whole file with
 * comments stripped. Depth 0 is top level — outside every `@layer` — which is
 * what makes the rule beat Tailwind's `layer(utilities)` import without an
 * `!important`. Returns -1 when the selector opens no block at all.
 */
function depthOfBlock(selector: string): number {
  const source = globals().replace(/\/\*[\s\S]*?\*\//g, "");
  const index = source.indexOf(`${selector} {`);
  if (index === -1) return -1;
  let depth = 0;
  for (const character of source.slice(0, index)) {
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
  }
  return depth;
}

// Escape every regular-expression metacharacter, the backslash included, so a
// token value with any shape can be matched literally.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe('clause: "10–12px radius"', () => {
  it("cuts the card two steps above the radius base, not on the shared xl step", () => {
    expect(globals()).toMatch(
      new RegExp(
        `\\[data-slot="card"\\]\\s*\\{[^}]*border-radius:\\s*${escapeRegExp(CORNER)}\\s*;`,
      ),
    );
  });

  it("states the corner where the cascade lets it win, with no !important", () => {
    // Tailwind's utilities arrive in `layer(utilities)`; an unlayered rule beats
    // a layered one whatever the specificity. The rule is therefore at top
    // level — not tucked inside `@layer utilities`, where it would be trading
    // specificity with `rounded-xl` instead of outranking it — and it does not
    // reach for `!important`, which would take the corner away from a consumer
    // for good rather than merely stating the default.
    expect(depthOfBlock('[data-slot="card"]')).toBe(0);
    const rule = globals().slice(globals().indexOf('[data-slot="card"] {'));
    expect(rule.slice(0, rule.indexOf("}"))).not.toContain("!important");
  });

  it("cuts the header, the footer and the image corners on that same step", () => {
    // The card clips its children (`overflow-hidden`), so a header or footer
    // left on a different step draws a visible seam inside the outer corner
    // the moment it paints a ground of its own — which the footer already
    // does. All four sites move together or none of them do.
    const source = globals();
    for (const seam of [
      '[data-slot="card"] [data-slot="card-header"]',
      '[data-slot="card"] > img:first-child',
      '[data-slot="card"] [data-slot="card-footer"]',
      '[data-slot="card"] > img:last-child',
    ]) {
      expect(source, `${seam} is left on the old step`).toContain(seam);
    }
    // …and the seams are cut with the same recipe as the card itself, on the
    // two corners each of them actually owns.
    expect(source).toMatch(
      /\[data-slot="card"\] \[data-slot="card-header"\],\s*\[data-slot="card"\] > img:first-child \{\s*border-top-left-radius: calc\(var\(--radius\) \+ 2px\);\s*border-top-right-radius: calc\(var\(--radius\) \+ 2px\);/,
    );
    expect(source).toMatch(
      /\[data-slot="card"\] \[data-slot="card-footer"\],\s*\[data-slot="card"\] > img:last-child \{\s*border-bottom-left-radius: calc\(var\(--radius\) \+ 2px\);\s*border-bottom-right-radius: calc\(var\(--radius\) \+ 2px\);/,
    );
  });

  it("leaves the vendored primitive byte-identical to its registry source", () => {
    // The reason the recipe is a scope and not a class, held as a test: the
    // moment the corner is spelled in this file, six extension repositories
    // drift from it and the provenance gate
    // (scripts/extensions/vendor-extension-primitives.mjs --check) fails until
    // all six have re-vendored and their pins have been raised.
    const source = readFileSync(
      join(process.cwd(), "src/components/ui/card.tsx"),
      "utf8",
    );
    expect(source).not.toContain("--radius");
  });

  it("lands inside the band under every --radius this product declares", () => {
    // THE ARITHMETIC, graded against the palette declarations themselves. A
    // reading in a browser proves the two palettes the page can be in; this
    // proves the recipe against every declaration in the file, including the
    // bare `:root` defaults that no shipped surface renders under but that
    // round 1 of this wave measured and was misled by.
    for (const selector of [":root", ".cinatra", ".dark"]) {
      const corner = radiusPxOf(selector) + 2;
      expect(corner, `${selector}: --radius + 2px = ${corner}px`).toBeGreaterThanOrEqual(
        BAND.min,
      );
      expect(corner, `${selector}: --radius + 2px = ${corner}px`).toBeLessThanOrEqual(
        BAND.max,
      );
    }
  });

  it("shows the shared xl step is what left the band, so the fix is not cosmetic", () => {
    // The reading that made this leg necessary, stated as arithmetic: the same
    // utility the primitive spells resolves to 14px in the dark palette. Kept
    // as a test rather than as prose so that a later change to the dark
    // palette's base is not mistaken for this clause being repaired.
    expect(radiusPxOf(".dark") + 4).toBeGreaterThan(BAND.max);
    expect(radiusPxOf(".cinatra") + 4).toBeLessThanOrEqual(BAND.max);
  });
});

describe('clause: "surface (default)"', () => {
  it("draws the presentation card on the card token, which the palette maps to --surface", () => {
    expect(slot(renderCard(), "card").className).toContain("bg-card");
  });

  it("lets a consuming surface pass its own ground without the base winning", () => {
    // The clause is about the DEFAULT. A card told to draw another ground must
    // actually draw it, or every consumer hand-rolls a container instead of
    // using the primitive — the drift this wave exists to stop.
    expect(slot(renderCard("bg-surface-strong"), "card").className).toContain(
      "bg-surface-strong",
    );
    expect(slot(renderCard("bg-surface-strong"), "card").className).not.toContain("bg-card");
  });
});

describe('clauses "surface-strong (interactive)", "1px line border" and "Hover lifts it 1px"', () => {
  // THE DEPARTURE THIS BLOCK RECORDED IS RETIRED. All three clauses were
  // recorded here as open, against the sibling change for this same issue,
  // which is the change this file now sits in: the card draws a real
  // `border border-border` instead of the old `ring-1`, carries the
  // `interactive` form the "White means interactive" rule reserves the white
  // ground for, and lifts that form 1px on hover. The three assertions below
  // are the SAME assertions the departure recorded, unchanged; only their
  // expected-failure markers are gone, which is what the record said would
  // have to happen on the day the repair landed.
  it('draws a real 1px border rather than a ring — clause "1px line border"', () => {
    // WHAT THIS REPLACED: the base spelled `ring-1 ring-foreground/10`, which
    // paints as a box-shadow. Its computed border-width was 0px, so a consumer
    // that passed a border colour got no stroke at all.
    expect(slot(renderCard(), "card").className).toMatch(/(^|\s)border(\s|$)/);
  });

  it('offers the clickable form the rule reserves white for — clause "surface-strong (interactive)"', () => {
    // WHAT THIS REPLACED: the primitive had one form, the presentation one, so
    // every surface that wanted the white ground hand-rolled its own
    // container — the drift this primitive exists to prevent.
    const container = renderInteractive();
    expect(slot(container, "card").getAttribute("data-interactive")).toBe("true");
  });

  it('lifts the clickable form 1px on hover — the section example "Hover lifts it 1px."', () => {
    expect(slot(renderInteractive(), "card").className).toContain("hover:-translate-y-px");
  });
});
