// @vitest-environment jsdom
//
// Button vs its own section in the components drawing (cinatra#3189, audit leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/button-variant-set.test.tsx
//
// The section states the variant set twice — once as a count ("7 variants") and
// once by name ("Primary, default, outline, secondary, destructive, ghost,
// link") — and the primitive shipped six of the seven: `primary`, the word the
// same section pins the indigo fill to ("Indigo primary"), had no spelling in
// the cva object at all, so a call site could not ask for it by the drawing's
// own name.
//
// jsdom applies no stylesheet, so this asserts the CONTRACT that produces the
// chrome — the class each named variant renders. The COMPUTED colours behind
// those classes are measured in the real browser by
// tests/e2e/design/conformance/primitive-chrome.spec.ts.
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Button, buttonVariants } from "@/components/ui/button";

afterEach(cleanup);

/** The seven names the drawing's Button section lists, in its own order. */
const DRAWN_VARIANTS = [
  "primary",
  "default",
  "outline",
  "secondary",
  "destructive",
  "ghost",
  "link",
] as const;

/** "Sizes: default, xs, sm, lg, icon (xs/sm/lg)" — five named sizes. */
const DRAWN_SIZES = ["default", "xs", "sm", "lg", "icon"] as const;

function renderButton(props: Record<string, unknown>) {
  const { container } = render(<Button {...props}>Label</Button>);
  const el = container.querySelector('[data-slot="button"]');
  if (!el) throw new Error("Button rendered no [data-slot=button]");
  return el;
}

/**
 * cva silently falls back to the base recipe for a key it does not know, so
 * "does this variant exist" cannot be asked by rendering it and reading back
 * the prop. It is asked by comparing against a control the recipe provably
 * does NOT know: a variant that resolves to the same classes as the control
 * is a variant the primitive cannot spell.
 */
const UNKNOWN = "__not-a-variant__";

describe("Button — components drawing, Button section", () => {
  it("renders all seven variants the drawing names, each as its own variant", () => {
    const control = buttonVariants({ variant: UNKNOWN as never });
    const missing = DRAWN_VARIANTS.filter(
      (variant) => buttonVariants({ variant }) === control,
    );
    expect(
      missing,
      `the drawing names 7 variants; the primitive cannot spell: ${missing.join(", ")}`,
    ).toEqual([]);
    for (const variant of DRAWN_VARIANTS) {
      expect(renderButton({ variant }).getAttribute("data-variant")).toBe(variant);
    }
  });

  it("draws primary as the indigo fill the drawing pins to that word", () => {
    const primary = renderButton({ variant: "primary" });
    expect(primary.className).toContain("bg-primary");
    expect(primary.className).toContain("text-primary-foreground");
  });

  it("leaves what default draws byte-identical to the new primary", () => {
    // `primary` NAMES the fill `default` already drew; adding the name must not
    // restyle the 200-plus call sites that ask for `default`.
    const asDefault = renderButton({ variant: "default" }).className;
    cleanup();
    const asPrimary = renderButton({ variant: "primary" }).className;
    expect(asPrimary).toBe(asDefault);
  });

  it("draws destructive as red-on-tint, never a solid red fill", () => {
    const el = renderButton({ variant: "destructive" });
    expect(el.className).toContain("bg-destructive/10");
    expect(el.className).toContain("text-destructive");
    expect(el.className).not.toMatch(/(^|\s)bg-destructive(\s|$)/);
  });

  it("renders the five sizes the drawing names", () => {
    const control = buttonVariants({ size: UNKNOWN as never });
    const missing = DRAWN_SIZES.filter(
      (size) => buttonVariants({ size }) === control,
    );
    expect(missing, `sizes the primitive cannot spell: ${missing.join(", ")}`).toEqual(
      [],
    );
    for (const size of DRAWN_SIZES) {
      expect(renderButton({ size }).getAttribute("data-size")).toBe(size);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Fix leg 2 (cinatra#3192) — the class contract behind the chrome the aborted
 * 2026-09-03 round measured wrong. The COLOURS these classes resolve to are
 * measured in a real browser, in both palettes, by
 * tests/e2e/design/conformance/primitive-chrome.spec.ts; jsdom applies no
 * stylesheet, so what is assertable here is which class each clause rides.
 * ──────────────────────────────────────────────────────────────────────────── */
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const HOST_RECIPE = path.join(REPO_ROOT, "src/components/ui/button.tsx");
const SDK_RECIPE = path.join(REPO_ROOT, "packages/sdk-ui/src/ui/button.tsx");

describe("Button — fix leg 2, the drawing's box and edges", () => {
  it("draws the 7px corner `.btn` pins, on every size", () => {
    // "border-radius: 7px" — one corner for the whole roster. The recipe used
    // to ride `rounded-lg`, which resolves through `--radius` and therefore
    // differed BETWEEN palettes: 6px under the app's light theme, 8px under
    // dark. A drawn constant cannot be a variable.
    expect(renderButton({}).className).toContain("rounded-[7px]");
    for (const size of DRAWN_SIZES) {
      cleanup();
      const el = renderButton({ size });
      const corners = el.className.split(/\s+/).filter((c) => c.includes("rounded-"));
      expect(corners, `size ${size} must not re-corner the button`).toEqual([
        "rounded-[7px]",
      ]);
    }
  });

  it("leaves no conditional corner in either recipe's size block", () => {
    // The per-size `rounded-[min(--radius-md,…)]` overrides are gone from the
    // rendered class list above, but a MODIFIER corner is invisible to a render
    // that does not put the button in the state it keys on: four sizes carried
    // `in-data-[slot=button-group]:rounded-lg`, which re-cornered exactly the
    // grouped button and sent it back through `--radius` — the variable the
    // drawn 7px constant exists to stop being. The size block is read as SOURCE
    // so a modifier cannot hide behind a state no test thought to mount.
    for (const file of [HOST_RECIPE, SDK_RECIPE]) {
      const source = readFileSync(file, "utf8");
      const start = source.indexOf("      size: {");
      expect(start, `${file} has no size block`).toBeGreaterThan(0);
      const end = source.indexOf("\n      },", start);
      expect(end, `${file} size block is not closed`).toBeGreaterThan(start);
      const block = source.slice(start, end);
      expect(block, `${file} re-corners the button inside its size block`).not.toContain(
        "rounded-",
      );
    }
  });

  it("draws the drawing's 7px 14px box rather than a fixed height", () => {
    // "padding: 7px 14px". The recipe used to state a fixed `h-8` with
    // horizontal padding only, so the measured box read `0px 10px`. The height
    // the drawing's own numbers produce — 7 + 7 + two 1px edges + a 16px line —
    // is the 32px the button already stood at, so the box is unchanged while
    // the padding becomes the thing that makes it.
    const el = renderButton({});
    expect(el.className).toContain("px-[14px]");
    expect(el.className).toContain("py-[7px]");
    expect(el.className).toContain("text-sm/4");
    expect(el.className).not.toMatch(/(^|\s)h-8(\s|$)/);
  });

  it("puts the primary edge on the blue, not on the navy", () => {
    // ".btn.primary { background: var(--blue); color: var(--surface-strong);
    //   border-color: var(--blue); }" — the navy edge the recipe carried is the
    // one the drawing gives the UNFILLED `.btn`, never the indigo fill.
    for (const variant of ["primary", "default"] as const) {
      cleanup();
      const el = renderButton({ variant });
      expect(el.className, `${variant} edge`).toContain("border-primary");
      expect(el.className, `${variant} edge`).not.toContain("border-line-strong");
      expect(el.className).toContain("bg-primary");
      expect(el.className).toContain("text-primary-foreground");
    }
  });

  it("draws outline on the surface, in ink, on the strong line", () => {
    // ".btn.outline { background: var(--surface); color: var(--ink);
    //   border-color: var(--line-strong); }" — measured white / indigo-at-0.9 /
    // a 0.14-alpha hairline before this leg.
    const el = renderButton({ variant: "outline" }).className;
    expect(el).toContain("bg-surface");
    expect(el).toContain("text-foreground");
    expect(el).toContain("border-line-strong-control");
    expect(el).not.toContain("bg-background");
    expect(el).not.toMatch(/(^|\s)border-border(\s|$)/);
    // The dark ramp gets the SAME rules through the palette's own tokens, so
    // there is no dark-only ground or edge left on this variant.
    expect(el).not.toContain("dark:border-input");
    expect(el).not.toContain("dark:bg-input-fill");
  });

  it("states the ghost's transparent ground rather than leaving it to the page", () => {
    // ".btn.ghost { background: transparent; border-color: transparent; }"
    const el = renderButton({ variant: "ghost" }).className;
    expect(el).toContain("bg-transparent");
    expect(el).toContain("text-foreground");
  });

  it("gives destructive the tinted edge the drawing draws", () => {
    // "border-color: rgba(166,56,79,0.24)" — the tint carries an edge of its
    // own; the recipe drew none at all.
    expect(renderButton({ variant: "destructive" }).className).toContain(
      "border-destructive/24",
    );
  });

  it("underlines the link variant at the drawn 3px offset", () => {
    // ".btn.link { … text-decoration: underline; text-underline-offset: 3px;
    //   padding: 7px 4px; }" — drawn underlined at rest, not on hover.
    const el = renderButton({ variant: "link" });
    expect(el.className).toMatch(/(^|\s)underline(\s|$)/);
    expect(el.className).toContain("underline-offset-[3px]");
    expect(el.className).not.toContain("hover:underline");
    expect(el.className).toContain("data-[variant=link]:px-[4px]");
  });
});
