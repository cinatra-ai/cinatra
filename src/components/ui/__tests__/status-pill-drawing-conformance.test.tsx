// @vitest-environment jsdom
//
// StatusPill — the graded checklist for the STATUS-PILL clause of the
// components drawing's "Badge / Pill" section (cinatra#3189,
// shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/status-pill-drawing-conformance.test.tsx
//
// The clause, quoted verbatim:
//
//   "Status pills (see V) use bg tinted from the status colour, text in the
//    same colour, border at higher alpha. Use icon-led pills; never just dots."
//
// plus the chrome line the section states for the family:
//
//   "9999px radius"
//
// WHERE THIS CLAUSE IS GRADED, and why it is graded HERE. The "Badge / Pill"
// section names two components. `<Badge />` is the generic chip; the status
// pill is its own primitive, `status-pill.tsx`, and it is the component the
// clause's three-part recipe (tinted ground, same-colour text, higher-alpha
// border) actually describes. Round 1 of this leg initially graded the clause
// at the badge's status VARIANTS instead and edited `badge.tsx` to add the
// strokes; that was the wrong seam — see badge-drawing-conformance.test.tsx
// for the record of that correction and the reason the badge is not edited.
//
// NO DEPARTURE FOUND.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";

afterEach(cleanup);

// The states the clause's "tinted from the status colour" recipe governs: the
// six that carry a STATUS colour. `queued`, `idle` and `archived` are the
// neutral states — they carry no status colour to tint from — and `failed` /
// `declined` are the terminal states the drawing's §V draws solid rather than
// tinted. Each of those two groups is graded in its own block below, so the
// relation asserted here stays the relation the clause actually states.
const TINTED: StatusPillStatus[] = [
  "running",
  "approved",
  "hold",
  "needs-review",
  "scheduled",
];

const NEUTRAL: StatusPillStatus[] = ["queued", "idle", "archived"];

function renderPill(status: StatusPillStatus) {
  const { container } = render(<StatusPill status={status}>Label</StatusPill>);
  return container.firstElementChild as HTMLElement;
}

describe('clause: "bg tinted from the status colour, text in the same colour, border at higher alpha"', () => {
  it.each(TINTED)(
    "draws '%s' as one status colour at three alphas — tinted ground, solid text, stronger stroke",
    (status) => {
      const cls = renderPill(status).className;
      // The recipe is graded as a RELATION, not as six literal strings: one
      // colour must appear as the text at full strength, as the ground at a
      // low alpha, and as the border at an alpha between the two.
      const text = cls.match(/(?:^|\s)text-([a-z-]+)(?:\s|$)/);
      expect(text, `${status} has no solid status text colour`).not.toBeNull();
      const colour = text![1];
      expect(cls, `${status} ground is not tinted from ${colour}`).toMatch(
        new RegExp(`(^|\\s)bg-${colour}/\\d+(\\s|$)`),
      );
      expect(cls, `${status} border is not drawn from ${colour}`).toMatch(
        new RegExp(`(^|\\s)border-${colour}/\\d+(\\s|$)`),
      );
      const bgAlpha = Number(cls.match(new RegExp(`bg-${colour}/(\\d+)`))![1]);
      const borderAlpha = Number(
        cls.match(new RegExp(`border-${colour}/(\\d+)`))![1],
      );
      expect(
        borderAlpha,
        `${status}: the border must sit at a HIGHER alpha than the ground`,
      ).toBeGreaterThan(bgAlpha);
    },
  );

  it("always draws a border, so the pill has an edge on every ground", () => {
    for (const status of [...TINTED, ...NEUTRAL]) {
      expect(renderPill(status).className).toMatch(/(^|\s)border(\s|$)/);
      cleanup();
    }
  });

  it("keeps the terminal states solid rather than tinted, which is what makes them terminal", () => {
    // "failed" and "declined" are the two states the drawing's §V treats as
    // terminal; they are drawn as a solid destructive fill, not a tint, so a
    // failure cannot be mistaken for a soft in-progress state.
    for (const status of ["failed", "declined"] as StatusPillStatus[]) {
      const cls = renderPill(status).className;
      expect(cls).toContain("bg-destructive");
      expect(cls).toContain("text-destructive-foreground");
      expect(cls).not.toMatch(/bg-destructive\/\d/);
      cleanup();
    }
  });
});

describe("the neutral states, which the clause's tint recipe does not reach", () => {
  it.each(NEUTRAL)(
    "draws '%s' in the muted ink rather than borrowing a status colour it does not have",
    (status) => {
      // The clause says a status pill is "tinted from the status colour". A
      // queued, idle or archived run has no status colour, so there is nothing
      // to tint from; these draw the muted ink on a near-transparent ground.
      // Grading them against the tint relation would invent a clause the
      // drawing does not state.
      const cls = renderPill(status).className;
      expect(cls).toContain("text-muted-foreground");
      expect(cls).not.toMatch(/(^|\s)text-(primary|success|warning|info)(\s|$)/);
    },
  );

  it("still gives the neutral states an edge and a glyph, which the clause does state for the family", () => {
    for (const status of NEUTRAL) {
      const pill = renderPill(status);
      expect(pill.className).toMatch(/(^|\s)border(\s|$)/);
      expect(pill.querySelector("svg")).not.toBeNull();
      cleanup();
    }
  });
});

describe('clause: "Use icon-led pills; never just dots"', () => {
  it.each([...TINTED, ...NEUTRAL, "failed", "declined"] as StatusPillStatus[])(
    "leads '%s' with a glyph",
    (status) => {
      const pill = renderPill(status);
      const glyph = pill.querySelector("svg");
      expect(glyph, `${status} renders no icon`).not.toBeNull();
    },
  );

  it("puts the glyph BEFORE the label, which is what 'icon-led' states", () => {
    const pill = renderPill("running");
    const glyph = pill.querySelector("svg")!;
    expect(
      pill.firstElementChild === glyph || pill.firstElementChild!.contains(glyph),
    ).toBe(true);
  });

  it("draws a shaped glyph, never a bare dot", () => {
    // "never just dots" is graded at the drawn geometry: a dot would be a lone
    // <circle>. Every state draws a path, polygon or rect instead.
    for (const status of TINTED) {
      const glyph = renderPill(status).querySelector("svg")!;
      const shapes = Array.from(glyph.children).map((c) => c.tagName.toLowerCase());
      expect(
        shapes.some((s) => s !== "circle"),
        `${status} draws only circles — that is a dot, which the clause forbids`,
      ).toBe(true);
      cleanup();
    }
  });
});

describe('clause: "9999px radius"', () => {
  it("draws the pill as a capsule", () => {
    expect(renderPill("running").className).toContain("rounded-full");
  });
});

describe('the clause\'s colour assignments (drawing §V)', () => {
  it("keeps 'running' indigo and the failures red — red never means run", () => {
    expect(renderPill("running").className).toContain("text-primary");
    cleanup();
    expect(renderPill("failed").className).toContain("bg-destructive");
  });
});
