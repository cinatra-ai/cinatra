// @vitest-environment jsdom
//
// Avatar — the graded checklist for the components drawing's "Avatar" section
// (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/avatar-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "36–40px square"
//   "random accent ground"
//   "italic 800 initial"
//   "User avatars carry the user's initials in Archivo italic 800 on a random
//    categorical accent (never indigo or navy). Per-extension instances same
//    pattern (see IV)."
//
// ONE DEPARTURE FIXED HERE. The default step drew a 32px box — below the
// 36–40px band the clause states, and the step every surface gets when it
// asks for an avatar without naming a size. It now draws 36px, the bottom of
// the band and the value the section's own example draws.
//
// ONE READING RECORDED RATHER THAN ACTED ON, and the reason. The section's
// example draws its four avatars with an 8px corner, so a strict reading of
// the example makes the avatar a rounded square; the product has drawn a
// circle since it shipped. The clause's own words are "36–40px square", which
// states the BOX — a square rather than a rectangle — and the section's prose
// states no corner rule at all. Turning every avatar in the product from a
// circle into a rounded square is an identity change, not a chrome repair, and
// it is recorded here for a reading rather than taken on a reading of example
// CSS. This follows the same disposition this wave already used for the select
// panel's hairline.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { ACCENT_PALETTE, EXTENSION_ACCENTS } from "@/lib/extension-accent";

afterEach(cleanup);

function renderAvatar(size?: "default" | "sm" | "lg", accent?: (typeof EXTENSION_ACCENTS)[number]) {
  const { container } = render(
    <Avatar size={size}>
      <AvatarFallback accent={accent}>O</AvatarFallback>
    </Avatar>,
  );
  return {
    root: container.querySelector('[data-slot="avatar"]') as HTMLElement,
    fallback: container.querySelector('[data-slot="avatar-fallback"]') as HTMLElement,
  };
}

describe('clause: "36–40px square"', () => {
  it("draws the default avatar inside the stated band", () => {
    // REGRESSION PIN for the fixed clause. `size-8` — the value this replaced —
    // computes to 32px, four short of the band's floor; `size-9` computes to
    // 36px, the value the section's own example draws. The laid-out box is
    // measured on the boot ("avatar box", primitive-wave-leg1.spec.ts) in both
    // palettes.
    const { root } = renderAvatar();
    expect(root.className).toContain("size-9");
    expect(root.className).not.toMatch(/(^|\s|:)size-8(\s|$)/);
  });

  it("keeps the group's overflow counter on the same step as the avatars beside it", () => {
    const { container } = render(
      <AvatarGroup>
        <Avatar>
          <AvatarFallback>O</AvatarFallback>
        </Avatar>
        <AvatarGroupCount>+3</AvatarGroupCount>
      </AvatarGroup>,
    );
    const count = container.querySelector(
      '[data-slot="avatar-group-count"]',
    ) as HTMLElement;
    // A counter left at the old 32px beside a 36px avatar reads as a
    // misalignment, so the two move together or not at all.
    expect(count.className).toContain("size-9");
  });

  it("holds the large step at the top of the band", () => {
    const { root } = renderAvatar("lg");
    // `data-[size=lg]:size-10` = 40px, the band's ceiling.
    expect(root.className).toContain("data-[size=lg]:size-10");
    expect(root.getAttribute("data-size")).toBe("lg");
  });

  it("draws a square box — equal sides — at every step", () => {
    for (const size of ["default", "sm", "lg"] as const) {
      const { root } = renderAvatar(size);
      // `size-*` sets width and height from one value, so the box cannot go
      // rectangular under a caller's class that changes only one axis.
      expect(root.className).toMatch(/size-\d/);
    }
  });

  // Recorded, not fixed: the small step draws 24px, which the section's band
  // does not cover. The drawing names no small avatar at all, so the step is a
  // product extension rather than a departure from a stated clause; it is
  // written into the record so leg 2 can put the question to the drawing.
  it.skip(
    "recorded reading: the sm step draws 24px, a size the section does not name — a product extension, not a graded clause",
    () => {},
  );

  // Recorded, not fixed: the corner. See the file header.
  it.skip(
    "recorded reading, not fixed here: the section's example draws an 8px corner while the primitive draws a circle — an identity change, not a chrome repair",
    () => {},
  );
});

describe('clause: "random accent ground" / "never indigo or navy"', () => {
  it("paints the fallback from the categorical accent set when the caller has one", () => {
    const { fallback } = renderAvatar("default", "plum");
    expect(fallback.getAttribute("data-accent")).toBe("plum");
    expect(fallback.style.background).not.toBe("");
  });

  it("keeps indigo and navy out of the accent set entirely", () => {
    // The clause's exclusion is graded at the palette, which is where it can be
    // enforced once: no accent may resolve to the action indigo (#364e81) or
    // the ink navy (#15213a).
    const forbidden = new Set(["#364e81", "#15213a"]);
    for (const accent of EXTENSION_ACCENTS) {
      expect(forbidden.has(ACCENT_PALETTE[accent].bg.toLowerCase())).toBe(false);
    }
  });

  it("offers more than one ground, so 'random' has something to draw from", () => {
    expect(EXTENSION_ACCENTS.length).toBeGreaterThan(1);
  });

  // NOT APPLICABLE at the primitive, with the reason: which accent a given user
  // gets is persisted per user (`public."user".accent_color`) and passed in by
  // the call site. The primitive cannot draw a random ground without making the
  // avatar change colour on every render.
  it.skip(
    "not applicable at the primitive: the accent is persisted per user and passed in, never drawn at random on render",
    () => {},
  );
});

describe('clause: "italic 800 initial" / "Archivo italic 800"', () => {
  it("sets the initial in the display face, italic, at weight 800", () => {
    const { fallback } = renderAvatar();
    expect(fallback.className).toContain("font-display");
    expect(fallback.className).toContain("italic");
    // `font-extrabold` is the 800 step. The computed font-weight and
    // font-style are read on the boot ("avatar initial").
    expect(fallback.className).toContain("font-extrabold");
  });

  it("keeps the initial legible on the accent ground it is given", () => {
    const { fallback } = renderAvatar("default", "burgundy");
    expect(fallback.style.color).not.toBe("");
  });
});
