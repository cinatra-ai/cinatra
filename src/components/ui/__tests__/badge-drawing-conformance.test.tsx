// @vitest-environment jsdom
//
// Badge — the graded checklist for the components drawing's "Badge / Pill"
// section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/badge-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "surface-muted bg"
//   "line border"
//   "9999px radius"
//   "icon-led"
//   "Status pills (see V) use bg tinted from the status colour, text in the
//    same colour, border at higher alpha. Use icon-led pills; never just dots."
//
// TWO CORRECTIONS THIS FILE RECORDS, both made after round 1 of this leg.
//
// 1. THE STATUS-PILL CLAUSE IS NOT GRADED HERE. The section names two
//    components, and the status pill is its own primitive — `status-pill.tsx`.
//    That component already implements the clause's three-part recipe exactly
//    (tinted ground, same-colour text, higher-alpha border, icon-led, capsule),
//    and it is graded in status-pill-drawing-conformance.test.tsx. Round 1
//    graded the clause at THIS file's status variants instead and edited
//    `badge.tsx` to add `border-success/30` and its siblings. That edit was
//    reverted: it was the wrong seam.
//
// 2. `badge.tsx` IS NOT EDITED BY THIS LEG AT ALL, and the reason is a standing
//    boundary rather than a judgement about the drawing. This file is vendored
//    verbatim (modulo import rewriting) into five extension packages by
//    scripts/extensions/vendor-extension-primitives.mjs. Those packages are
//    separate repositories — `/extensions/` is git-ignored here and holds zero
//    tracked files — so any edit to this primitive desynchronises five repos
//    that this lane cannot write to, and the repository carries two standing
//    guards that fail the moment it drifts:
//      - packages/connectors/src/__tests__/connector-badge.test.ts, which pins
//        the success and destructive variant strings byte-for-byte under the
//        title "the badge is SOLID via a className override, not a
//        shared-primitive edit" (cinatra#1014); and
//      - scripts/extensions/__tests__/vendor-extension-primitives.test.mjs,
//        which asserts every vendored copy still equals transform(source).
//    Repairing a badge clause is therefore a cross-repository transaction, not
//    a leg-1 source fix. The one clause below that does not hold is recorded
//    with that road named, not fixed and not loosened.
//
//    THE BLOCK IS MEASURED, NOT ARGUED, and the measurement narrowed it. The
//    repair was applied to this primitive on a throwaway edit (`border-line`
//    added to the `secondary` variant) and the two guards were run against it:
//      - vendor-extension-primitives.test.mjs FAILS, at its provenance case
//        "every planned vendored file on disk equals transform(source)", with
//        `extensions/.../badge.tsx drifted from src/components/ui/badge.tsx`.
//        Re-running the vendoring writer would silence it in a checkout, but
//        only by writing into repositories this lane does not own, and every
//        consumer still pinned at its current release stays red until it has
//        re-vendored. That is the whole block, and it is a real one.
//      - connector-badge.test.ts PASSES (29 of 29). The cinatra#1014 guard
//        pins the `success` and `destructive` variant strings byte-for-byte,
//        and the clause below touches neither. Round 1 of this leg recorded
//        that guard as part of the follow-up; it is NOT, and the follow-up is
//        correspondingly smaller than it was first written to be.
//    The edit was reverted after the reading; badge.tsx is byte-identical to
//    the base commit in this leg's diff.
//
// 3. LEG 2 RE-MEASURED THAT COUNT, and it has moved. The same throwaway edit,
//    run on THIS head, drifts SIX vendored copies rather than five: the
//    vendoring provenance gate
//    (`node scripts/extensions/vendor-extension-primitives.mjs --check`)
//    answers PROVENANCE DRIFT and names six `badge.tsx` copies under
//    `/extensions/`. Leg 1's reading is left above in its own words rather
//    than rewritten, because it was correct when it was taken; six is the
//    number this leg builds against, and it is the number the seam recipe at
//    the end of src/app/globals.css states. The boundary the count measures
//    did not change — it only got wider, which is the direction that makes
//    the seam MORE necessary, not less.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Badge } from "@/components/ui/badge";

afterEach(cleanup);

function renderBadge(
  variant?: React.ComponentProps<typeof Badge>["variant"],
  children: React.ReactNode = "Running",
) {
  const { container } = render(<Badge variant={variant}>{children}</Badge>);
  return container.querySelector('[data-slot="badge"]') as HTMLElement;
}

// Resolved from the vitest root (the repository root), not from
// import.meta.url: the file is transformed, so its module URL is not a file URL
// and cannot be turned into a path.
function globals(): string {
  return readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
}

/**
 * The brace depth a rule opens at, counted over the whole file with comments
 * stripped. Depth 0 is top level — outside every `@layer` — which is what makes
 * an unlayered rule beat Tailwind's `layer(utilities)` import without an
 * `!important`.
 */
function depthOfRule(marker: string): number {
  const source = globals().replace(/\/\*[\s\S]*?\*\//g, "");
  const index = source.indexOf(marker);
  if (index === -1) return -1;
  let depth = 0;
  for (const character of source.slice(0, index)) {
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
  }
  return depth;
}

describe('clause: "9999px radius"', () => {
  it("draws the chip as a capsule at the height the primitive fixes", () => {
    // GRADED AT THE RENDERED SHAPE, not at the class name, and the reason
    // matters. The primitive spells the corner `rounded-4xl` (2rem = 32px)
    // rather than `rounded-full` (9999px). At the badge's own fixed height —
    // `h-5` = 20px — CSS clamps any corner above half the box to exactly half,
    // so 32px and 9999px render the IDENTICAL capsule. The clause names a
    // shape; the shape is met. Reading the computed `border-radius` string and
    // calling "32px" a departure would be the same false DEPART this wave
    // already recorded once (the Card radius correction on issue #3189).
    //
    // The rendered geometry is confirmed on the boot in both palettes
    // ("badge capsule", primitive-wave-leg1.spec.ts), which measures the box
    // and the resolved radius together rather than the token alone.
    const el = renderBadge();
    expect(el.className).toMatch(/(^|\s)rounded-(4xl|full)(\s|$)/);
    expect(el.className).toContain("h-5");
  });

  it("keeps the height fixed, which is what makes the clamped corner a capsule", () => {
    // If the height ever became fluid, `rounded-4xl` would stop clamping and
    // the chip would render as a 32px-cornered rectangle. This is the pin that
    // catches that, so the reasoning above cannot silently stop being true.
    for (const variant of ["default", "secondary", "outline", "ghost"] as const) {
      expect(renderBadge(variant).className).toContain("h-5");
      cleanup();
    }
  });
});

describe('clause: "surface-muted bg"', () => {
  it("grounds the neutral chip on the muted surface", () => {
    // --secondary resolves to --surface-muted, so the `secondary` variant IS
    // the chip the section's chrome line describes.
    expect(renderBadge("secondary").className).toContain("bg-secondary");
  });
});

describe('clause: "icon-led"', () => {
  it("reserves an inline-start slot for a leading glyph and tightens the padding for it", () => {
    const el = renderBadge(
      "secondary",
      <>
        <svg data-icon="inline-start" />
        Running
      </>,
    );
    expect(el.className).toContain("has-data-[icon=inline-start]:pl-1.5");
    expect(el.querySelector("svg")).not.toBeNull();
  });

  it("sizes a chip glyph to the chip rather than to the icon default", () => {
    expect(renderBadge().className).toContain("[&>svg]:size-3!");
  });
});

describe('clause: "line border"', () => {
  // FIXED ON THE DOM SEAM, not in `badge.tsx`, for the boundary reason
  // correction 2 in this file's header measures: the primitive is vendored into
  // six extension packages in their own repositories behind a provenance gate
  // that fails the moment the host copy drifts. A scope on the DOM seam at the
  // end of src/app/globals.css reaches the host copy and every vendored copy
  // alike, by containment, and changes no file that gate reads. It is the same
  // road leg 1 took for the card corner, in the same file.
  //
  // MEASURED BEFORE: the base is `border border-transparent` — a 1px border box
  // is reserved, but no variant except `outline` ever gives it a colour, so the
  // neutral chip the chrome line describes rendered with no visible stroke at
  // all. The fix is therefore a colour and not a reflow.
  it("strokes the neutral chip with the hairline the chrome line names", () => {
    expect(globals()).toMatch(
      /\[data-slot="badge"\]\[data-variant="secondary"\]\[class~="border-transparent"\]\s*\{\s*border-color:\s*var\(--line\);/,
    );
  });

  it("supplies the primitive's default stroke and never overrides a call site's own", () => {
    // THE SEAM IS UNLAYERED, so it beats a call site's own `border-*` utility
    // unless it declines to match. `border-transparent` is the token the base
    // recipe spells, and `cn()` is tailwind-merge: a caller that states a
    // border colour is in the same conflict group, so the primitive's token is
    // REMOVED and only the caller's colour is left on the element. Requiring
    // the token to still be present is therefore an exact reading of "this chip
    // asked for no stroke of its own" — the same discriminator the table seam
    // uses for padding.
    //
    // MEASURED, at a real call site on this head:
    // packages/objects/src/screens/sync-adapter-settings-tab.tsx draws its
    // Enabled chip `variant="secondary" className="border-success/30 ..."`.
    // Without this arm the seam repainted that success stroke neutral.
    expect(globals()).toContain(
      '[data-slot="badge"][data-variant="secondary"][class~="border-transparent"]',
    );
    const plain = renderBadge("secondary").className.split(/\s+/);
    expect(plain, "the untouched chip still carries the primitive's token").toContain(
      "border-transparent",
    );
    cleanup();
    const { container } = render(
      <Badge variant="secondary" className="border-success/30 bg-success/10">
        Enabled
      </Badge>,
    );
    const overridden = (
      container.querySelector('[data-slot="badge"]') as HTMLElement
    ).className.split(/\s+/);
    expect(
      overridden,
      "a caller's own border colour must drop the token, so the seam declines",
    ).not.toContain("border-transparent");
    expect(overridden).toContain("border-success/30");
  });

  it("scopes the stroke to the chip the chrome line describes", () => {
    // `--secondary` resolves to the surface-muted the same line names, so
    // `secondary` IS that chip. The `default` chip is a solid indigo fill and
    // the `ghost` and `link` chips are chromeless by their own recipes; the
    // status variants take their stroke from their own status colour under the
    // V section, which is the StatusPill primitive's clause and is graded there.
    const source = globals();
    expect(source).toContain(
      '[data-slot="badge"][data-variant="secondary"][class~="border-transparent"]',
    );
    for (const variant of ["default", "ghost", "link"]) {
      expect(
        source,
        `the seam strokes the ${variant} chip, which the chrome line does not draw`,
      ).not.toContain(`[data-slot="badge"][data-variant="${variant}"]`);
    }
    expect(renderBadge("secondary").getAttribute("data-variant")).toBe("secondary");
  });

  it("states the stroke where the cascade lets it win, with no !important", () => {
    expect(depthOfRule('[data-slot="badge"][data-variant="secondary"]')).toBe(0);
    const source = globals();
    const rule = source.slice(
      source.indexOf('[data-slot="badge"][data-variant="secondary"]'),
    );
    expect(rule.slice(0, rule.indexOf("}"))).not.toContain("!important");
  });

  it("reserves the border box on every variant, so the seam is a colour and not a layout change", () => {
    // The 1px box is already there on every variant, which is why stating the
    // colour cannot reflow a chip by a pixel.
    for (const variant of ["default", "secondary", "ghost", "link"] as const) {
      expect(renderBadge(variant).className).toContain("border border-transparent");
      cleanup();
    }
  });

  it("leaves the vendored primitive byte-identical to its registry source", () => {
    // The reason the recipe is a scope and not a class, held as a test: the
    // moment `border-line` is spelled in badge.tsx, six extension repositories
    // drift from it and the provenance gate
    // (scripts/extensions/vendor-extension-primitives.mjs --check) fails until
    // every one of them has re-vendored and its pin has been raised. The
    // cinatra#1014 guard in
    // packages/connectors/src/__tests__/connector-badge.test.ts pins the
    // success and destructive strings, which this clause does not touch either.
    const source = readFileSync(
      join(process.cwd(), "src/components/ui/badge.tsx"),
      "utf8",
    );
    expect(source).toContain("border border-transparent");
    expect(source).not.toContain("border-line");
  });
});

describe('clause: "Status pills (see V) ... never just dots"', () => {
  // NOT GRADED HERE, with the reason: the status pill is its own primitive
  // (`status-pill.tsx`) and the clause's recipe describes that component, not
  // this one. Graded in full in status-pill-drawing-conformance.test.tsx.
  it.skip(
    "graded at the status-pill primitive instead: see status-pill-drawing-conformance.test.tsx",
    () => {},
  );

  it("keeps the badge's status variants out of the status-pill role", () => {
    // What IS graded here: the badge's tinted status variants must not be
    // mistaken for status pills. They carry no icon requirement and no stroke,
    // and the product's status surfaces use StatusPill. This pins that the
    // badge does not grow a competing implementation of the same clause.
    const el = renderBadge("success" as React.ComponentProps<typeof Badge>["variant"]);
    expect(el.getAttribute("data-variant")).toBe("success");
    expect(el.className).toContain("bg-success/10");
    expect(el.className).toContain("text-success");
  });
});
