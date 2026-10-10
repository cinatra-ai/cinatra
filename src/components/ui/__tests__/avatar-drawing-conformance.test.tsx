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
// The approved section also draws four 36px avatars with 8px corners.
// These native assertions enforce the Source utility/prop contract; they do
// not measure browser paint. The standalone browser spec reads the actual
// default/fallback/pseudo geometry in both palettes; App image proof is owed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "@/components/ui/avatar";
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

  it("follows the four approved 8px corner examples and inherits their border/fallback shape", () => {
    const { root, fallback } = renderAvatar();
    expect(root.className.split(/\s+/)).toContain("rounded-[8px]");
    expect(root.className.split(/\s+/)).toContain("after:rounded-[inherit]");
    expect(fallback.className.split(/\s+/)).toContain("rounded-[inherit]");
    expect(root.className.split(/\s+/)).not.toContain("rounded-full");
  });

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

// Only the external browser image readiness port is supplied: the actual
// Radix Root/Image/Fallback components and their loading dispatch execute.
function loadedImagePort() {
  const image = document.createElement("img");
  Object.defineProperties(image, {
    complete: { get: () => true }, naturalWidth: { get: () => 36 },
  });
  return image;
}

describe("corner inheritance and preserved caller contracts", () => {
  it("honors root circle classes and inline corner styles without changing child defaults", () => {
    const { container } = render(
      <Avatar className="h-8 w-8 rounded-full" style={{ borderRadius: "13px" }} aria-label="Owner">
        <AvatarFallback accent="plum">O</AvatarFallback>
      </Avatar>,
    );
    const root = container.querySelector('[data-slot="avatar"]') as HTMLElement;
    const fallback = container.querySelector('[data-slot="avatar-fallback"]') as HTMLElement;
    expect(root.className.split(/\s+/)).toContain("rounded-full");
    expect(root.className.split(/\s+/)).not.toContain("rounded-[8px]");
    expect(root.style.borderRadius).toBe("13px");
    expect(root.getAttribute("aria-label")).toBe("Owner");
    expect(fallback.className.split(/\s+/)).toContain("rounded-[inherit]");
  });

  it("keeps the deliberate nav-menu rounded-lg override and all size props", () => {
    for (const size of ["default", "sm", "lg"] as const) {
      const { container, unmount } = render(<Avatar size={size} className="rounded-lg" data-owner="menu"><AvatarFallback>O</AvatarFallback></Avatar>);
      const root = container.querySelector('[data-slot="avatar"]') as HTMLElement;
      expect(root.className.split(/\s+/)).toContain("rounded-lg");
      expect(root.className.split(/\s+/)).not.toContain("rounded-[8px]");
      expect(root.getAttribute("data-size")).toBe(size);
      expect(root.getAttribute("data-owner")).toBe("menu");
      unmount();
    }
  });

  it("preserves explicit fallback class/style precedence over inherited shape and accent", () => {
    const { container } = render(<Avatar><AvatarFallback accent="plum" className="rounded-none" style={{ borderRadius: "3px", background: "red", color: "white" }}>O</AvatarFallback></Avatar>);
    const fallback = container.querySelector('[data-slot="avatar-fallback"]') as HTMLElement;
    expect(fallback.className.split(/\s+/)).toContain("rounded-none");
    expect(fallback.className.split(/\s+/)).not.toContain("rounded-[inherit]");
    expect(fallback.style.borderRadius).toBe("3px");
    expect(fallback.style.background).toBe("red");
    expect(fallback.style.color).toBe("white");
    expect(fallback.getAttribute("data-accent")).toBe("plum");
  });

  it("renders the real loaded Radix image with inherited corners and forwarded asset props", () => {
    vi.stubGlobal("Image", loadedImagePort);
    try {
      const { container } = render(<Avatar className="rounded-lg"><AvatarImage src="/owner.png" alt="Owner" crossOrigin="anonymous" /><AvatarFallback>O</AvatarFallback></Avatar>);
      const image = container.querySelector('[data-slot="avatar-image"]') as HTMLImageElement;
      expect(image).not.toBeNull();
      expect(image.tagName).toBe("IMG");
      expect(image.className.split(/\s+/)).toContain("rounded-[inherit]");
      expect(image.getAttribute("src")).toBe("/owner.png");
      expect(image.getAttribute("alt")).toBe("Owner");
      expect(image.crossOrigin).toBe("anonymous");
      expect(container.querySelector('[data-slot="avatar-fallback"]')).toBeNull();
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("preserves explicit image class and inline style overrides through real loading", () => {
    vi.stubGlobal("Image", loadedImagePort);
    try {
      const { container } = render(<Avatar><AvatarImage src="/owner.png" className="rounded-full" style={{ borderRadius: "5px" }} /></Avatar>);
      const image = container.querySelector('[data-slot="avatar-image"]') as HTMLImageElement;
      expect(image).not.toBeNull();
      expect(image.className.split(/\s+/)).toContain("rounded-full");
      expect(image.className.split(/\s+/)).not.toContain("rounded-[inherit]");
      expect(image.style.borderRadius).toBe("5px");
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("leaves undrawn group counters and status badges circular with caller precedence", () => {
    const { container } = render(<AvatarGroup><Avatar><AvatarFallback>O</AvatarFallback><AvatarBadge data-status="online" /></Avatar><AvatarGroupCount>+3</AvatarGroupCount></AvatarGroup>);
    const count = container.querySelector('[data-slot="avatar-group-count"]') as HTMLElement;
    const badge = container.querySelector('[data-slot="avatar-badge"]') as HTMLElement;
    expect(count.className.split(/\s+/)).toContain("rounded-full");
    expect(count.className.split(/\s+/)).toContain("size-9");
    expect(badge.className.split(/\s+/)).toContain("rounded-full");
    expect(badge.getAttribute("data-status")).toBe("online");
    expect(count.textContent).toBe("+3");
  });
});
