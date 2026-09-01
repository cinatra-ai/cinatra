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

  it("keeps the ink default border on the default variant", () => {
    expect(renderButton({ variant: "default" }).className).toContain(
      "border-line-strong",
    );
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
