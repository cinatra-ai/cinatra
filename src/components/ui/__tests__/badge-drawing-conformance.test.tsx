// @vitest-environment jsdom
// Badge neutral borders, cinatra#3189 / App424.
// Approved components: Secondary transparent border; Outline --line-strong.
// These are existing theme roles in both palettes. DOM checks bind real Badge
// behavior and caller precedence; stylesheet reads bind the cascade recipe.
// Actual browser values and the composite grade remain separate proof.
// The old six-copy vendor road is retired; status/destructive/default recipes
// and StatusPill's separate contract remain outside this correction.
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
    // the chip the section's approved neutral example describes.
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

describe('clause: "Secondary transparent border; Outline line-strong"', () => {
  // The existing unlayered seam must preserve transparency without stealing
  // explicit caller borders. Outline obtains its stroke in the primitive.
  it("keeps the neutral chip border transparent in the host cascade", () => {
    expect(globals()).toMatch(
      /\[data-slot="badge"\]\[data-variant="secondary"\]\[class~="border-transparent"\]\s*\{\s*border-color:\s*transparent;/,
    );
  });

  it("preserves explicit caller border colors on Secondary and Outline", () => {
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
    cleanup();
    const outline = render(
      <Badge variant="outline" className="border-success/30" aria-label="Custom outline">
        Outline
      </Badge>,
    ).getByLabelText("Custom outline");
    expect(outline.textContent).toBe("Outline");
    expect(outline.className.split(/\s+/)).toContain("border-success/30");
    expect(outline.className).not.toContain("border-[var(--line-strong)]");

  });

  it("scopes the stroke to the chip the approved neutral example describes", () => {
    // Only the untouched secondary base token matches this rule. Other
    // variants and explicit caller borders retain their own recipes.
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

  it("states transparency where the cascade lets it win, with no !important", () => {
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

  it("draws the real Outline chip with the strong hairline and preserves its composed element", () => {
    const { getByRole } = render(
      <Badge variant="outline" asChild>
        <a href="#agents">Outline</a>
      </Badge>,
    );
    const chip = getByRole("link", { name: "Outline" });
    expect(chip.getAttribute("href")).toBe("#agents");
    expect(chip.getAttribute("data-slot")).toBe("badge");
    expect(chip.getAttribute("data-variant")).toBe("outline");
    expect(chip.className.split(/\s+/)).toContain("border-[var(--line-strong)]");
    expect(chip.className.split(/\s+/)).not.toContain("border-border");
    expect(chip.className).toContain("text-foreground");
    expect(chip.className).toContain("h-5");
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
