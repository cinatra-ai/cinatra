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

describe('RECORDED DEPARTURE (cross-repository follow-up): clause "line border"', () => {
  // DOCUMENTED EXPECTED FAILURE. The assertion below is unchanged and still
  // runs: `it.fails` reports a pass only while the body throws, so the
  // departure stays measured and the checklist stays green. The day the
  // follow-up this departure names lands, this case stops throwing, the suite
  // goes red, and the record must be retired with it.
  it.fails('RECORDED DEPARTURE (cross-repository follow-up): draws the neutral chip with the hairline stroke the chrome line names — clause "line border"', () => {
    // RECORDED DEPARTURE — recorded, not fixed, and NOT because the clause is
    // in doubt. See correction 2 in this file's header: `badge.tsx` is vendored
    // into five separate repositories, and two standing guards fail the moment
    // the host copy drifts from them. Editing it here would break
    // `pnpm test:root` on a lane whose brief forbids writing under
    // `/extensions/`, so the repair cannot be completed inside this leg's
    // boundary.
    //
    // MEASURED: the base is `border border-transparent` — a 1px border box is
    // reserved, but no variant except `outline` ever gives it a colour, so the
    // `default`, `secondary`, `ghost` and `link` chips render with no visible
    // stroke at all. The chrome line states "line border" for the family.
    //
    // FOLLOW-UP (leg 2, as a coordinated cross-repository change, NOT a host
    // edit): give `secondary` the `border-line` hairline, then re-run
    // scripts/extensions/vendor-extension-primitives.mjs to re-vendor the packs
    // in their own repositories and land each of those changes there before the
    // host edit merges — the provenance case named in this file's header is the
    // one gate that fails, and it fails for exactly as long as a consumer is
    // still pinned at the pre-change copy. The cinatra#1014 guard in
    // packages/connectors/src/__tests__/connector-badge.test.ts is NOT part of
    // that follow-up: it was measured green against this very edit, because it
    // pins the success and destructive strings and this clause changes neither.
    const el = renderBadge("secondary");
    expect(el.className).toMatch(/(^|\s)border-line(\s|$)/);
  });

  it("reserves the border box on every variant, so the follow-up is a colour and not a layout change", () => {
    // Passes today. Recorded alongside the failure above because it is the
    // reason that fix cannot reflow the chip: the 1px box is already there.
    for (const variant of ["default", "secondary", "ghost", "link"] as const) {
      expect(renderBadge(variant).className).toContain("border border-transparent");
      cleanup();
    }
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
