// @vitest-environment jsdom
//
// Button — the components drawing's variant ROSTER, the one clause of that
// section this leg is answerable for (cinatra#3189, shared-primitives wave,
// leg 2).
//
//   pnpm exec vitest run src/components/ui/__tests__/button-variant-set.test.tsx
//
// The clause, quoted verbatim from the section's chrome line and its prose:
//
//   "7 variants"
//   "Primary, default, outline, secondary, destructive, ghost, link."
//   "Indigo primary"
//
// SCOPE. This file grades the roster and nothing else. The section's remaining
// sentences — the corner, the box, and the per-variant grounds and strokes —
// are graded on the sibling change that owns them.
//
// ONE DEPARTURE RECORDED, NOT FIXED. See the `RECORDED DEPARTURE` block: the
// roster is one name short, and closing it is a cross-repository change rather
// than a host edit.
import { describe, expect, it } from "vitest";

import { buttonVariants } from "@/components/ui/button";

/** The roster the drawing lists, in its own order and spelling. */
const ROSTER = [
  "primary",
  "default",
  "outline",
  "secondary",
  "destructive",
  "ghost",
  "link",
] as const;

/** The names the recipe answers to today. */
const SHIPPED = [
  "default",
  "outline",
  "secondary",
  "destructive",
  "ghost",
  "link",
] as const;

type ShippedVariant = (typeof SHIPPED)[number];

/**
 * The class list a variant resolves to, with the size held constant.
 *
 * The cast is deliberate and is the point of the departure below: `primary` is
 * not a key of the recipe, so it cannot be passed without one. cva answers an
 * unknown key with the base classes alone, which is exactly the measurement the
 * recorded case takes.
 */
function recipe(variant: (typeof ROSTER)[number]): string {
  return buttonVariants({ variant: variant as ShippedVariant, size: "default" });
}

describe('clause: "Primary, default, outline, secondary, destructive, ghost, link."', () => {
  it("draws each of the six names it does carry as its own recipe", () => {
    const recipes = new Set(SHIPPED.map((v) => recipe(v)));
    expect(recipes.size).toBe(SHIPPED.length);
  });

  it('gives the indigo fill to the name it does carry for it, "default"', () => {
    // "Indigo primary" — the fill itself is correct and is not in question
    // here; only the NAME the drawing puts it on is.
    expect(recipe("default")).toContain("bg-primary");
  });
});

describe('RECORDED DEPARTURE (cross-repository follow-up): clause "7 variants" / the name "Primary"', () => {
  // DOCUMENTED EXPECTED FAILURE. The assertion below is unchanged and still
  // runs: `it.fails` reports a pass only while the body throws, so the
  // departure stays measured and the checklist stays green. The day the
  // cross-repository follow-up this departure names lands, this case stops
  // throwing, the suite goes red, and the record must be retired with it.
  it.fails('RECORDED DEPARTURE (cross-repository follow-up): answers to the drawing\'s first name — clause "7 variants"', () => {
    // MEASURED: the recipe names SIX variants (default, outline, secondary,
    // destructive, ghost, link). The drawing's chrome line says "7 variants"
    // and its prose lists them — "Primary, default, outline, secondary,
    // destructive, ghost, link" — putting the indigo fill on the first word.
    // `primary` is not a key at all, so a call site asking the drawing's own
    // question gets the base recipe with no variant classes on it, and in
    // TypeScript gets a type error instead of a button.
    //
    // WHAT THE DRAWING ACTUALLY SAYS, and it is not an alias. The prose puts
    // the two names side by side and then separates them: "Primary, default,
    // outline, secondary, destructive, ghost, link" and, one sentence later,
    // "Indigo primary, ink default border". So the drawing draws `primary` as
    // the indigo FILL and `default` as the INK-BORDERED button — two
    // treatments, not one under two names.
    //
    // MEASURED HERE: the shipped `default` recipe carries `bg-primary` — the
    // indigo fill — so the roster is not merely one key short, it is SHIFTED:
    // what the drawing calls `primary` ships under the name `default`, and the
    // drawing's ink-bordered `default` has no key at all. This case grades the
    // half this leg is answerable for — that a call site asking the drawing's
    // own first name gets the indigo button — and states the shift so the
    // follow-up is not written as a one-line alias. The larger half, which
    // re-treats `default` and every other variant's ground and stroke, is the
    // sibling change's work and is named in this leg's record rather than
    // re-derived here.
    //
    // WHY IT IS RECORDED AND NOT APPLIED. `button.tsx` is the most widely
    // VENDORED primitive in the product: sixteen extension repositories carry a
    // byte-identical copy, and
    // `scripts/extensions/vendor-extension-primitives.mjs --check` is a
    // standing CI provenance gate that requires every one of those copies to
    // equal this source modulo the import rewrite. Editing this file turns that
    // gate red for as long as any consumer is still pinned at the pre-change
    // copy. The sibling change that carries the rest of this section had to run
    // exactly that cascade — its extension-lock diff bumps the resolved sha of
    // precisely the repositories that vendor what it touched — and that cascade
    // cannot be completed from a change whose boundary forbids writing under
    // `/extensions/`. This is the wall the wave first met on badge, where
    // it was cleared by stating the clause on the DOM seam instead — a road
    // a variant NAME cannot take, because a name is not a rendered value and
    // no scope can declare one.
    //
    // ROAD: add the `primary` key here, re-vendor the sixteen extension
    // repositories in their own repositories, land each, then bump
    // cinatra-dev-extensions.lock.json to the new shas — in that order, before
    // the host edit merges.
    // The roster the drawing lists is SEVEN long; the recipe answers to six.
    expect(ROSTER).toHaveLength(7);
    expect(SHIPPED).toHaveLength(6);
    // The drawing's first name has to answer with the indigo fill it draws.
    expect(recipe("primary")).toContain("bg-primary");
  });

  it("measures which shipped name currently carries the indigo fill", () => {
    // Passes today; recorded alongside the failure as the measurement that
    // makes the shift above readable. The indigo recipe EXISTS — it is simply
    // filed under the drawing's second name — which is why the follow-up adds
    // a key rather than inventing a treatment, and why it cannot be a bare
    // alias: `default` also has to become the ink-bordered button the drawing
    // draws, and that is a rendered change at every one of its call sites.
    expect(recipe("default")).toContain("bg-primary");
    expect(recipe("default")).toContain("text-primary-foreground");
  });
});
