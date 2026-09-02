/**
 * AN ALPHA NOBODY COULD READ IS NOT A PASSING ONE (cinatra#3142, acceptance 7).
 *
 *   pnpm exec vitest run src/app/__tests__/computed-color-alpha.test.ts
 *
 * The header band's opacity gate reads the band's COMPUTED ground and requires
 * alpha 1. A computed colour comes back in whatever syntax the author wrote,
 * and this token layer writes its grounds in `oklch()`, which spells its alpha
 * after a slash. A reader that only understands `rgba(r, g, b, a)` therefore
 * calls every modern translucent ground opaque — and the gate that trusted it
 * would pass the very band it exists to fail.
 *
 * So the reader understands both spellings, and says so when it understands
 * neither.
 */
import { describe, expect, it } from "vitest";

import { alphaOf } from "../../../tests/e2e/design/conformance/computed-color";

describe("the legacy spelling", () => {
  it("reads the fourth component of rgba()", () => {
    expect(alphaOf("rgba(9, 12, 20, 0.9)")).toBeCloseTo(0.9, 6);
  });

  it("reads rgb() with no alpha as opaque", () => {
    expect(alphaOf("rgb(9, 12, 20)")).toBe(1);
  });

  it("reads hsla()'s fourth component", () => {
    expect(alphaOf("hsla(220, 40%, 12%, 0.5)")).toBeCloseTo(0.5, 6);
  });
});

describe("the modern spellings this token layer actually writes", () => {
  it("reads the alpha oklch() spells after the slash", () => {
    expect(alphaOf("oklch(0.21 0.04 265 / 0.9)")).toBeCloseTo(0.9, 6);
  });

  it("reads that alpha written as a percentage", () => {
    expect(alphaOf("oklch(1 0 0 / 90%)")).toBeCloseTo(0.9, 6);
  });

  it("reads a translucent color() the same way", () => {
    expect(alphaOf("color(srgb 0.04 0.05 0.08 / 0.9)")).toBeCloseTo(0.9, 6);
  });

  it("reads oklab() and color-mix() outputs", () => {
    expect(alphaOf("oklab(0.21 0.02 -0.04 / 0.5)")).toBeCloseTo(0.5, 6);
    expect(alphaOf("color-mix(in oklab, oklch(1 0 0), black 20% / 0.25)")).toBeCloseTo(
      0.25,
      6,
    );
  });

  it("reads the alpha-less modern forms as opaque", () => {
    expect(alphaOf("oklch(0.21 0.04 265)")).toBe(1);
    expect(alphaOf("color(srgb 0.04 0.05 0.08)")).toBe(1);
    expect(alphaOf("rgb(9 12 20)")).toBe(1);
    expect(alphaOf("oklch(0.21 0.04 265 / none)")).toBe(1);
  });
});

describe("what it refuses to call opaque", () => {
  it("reads the keyword transparent as alpha zero", () => {
    expect(alphaOf("transparent")).toBe(0);
  });

  it("returns null for a serialization it does not understand", () => {
    // A gate that assumed 1 here would pass a band it never actually read.
    for (const unreadable of ["", "chartreuse", "#0a0c14", "var(--background)"]) {
      expect(alphaOf(unreadable), `${unreadable} was read as an alpha`).toBeNull();
    }
  });

  it("does not round a nearly-opaque ground up to opaque", () => {
    expect(alphaOf("oklch(0.21 0.04 265 / 0.999)")).not.toBe(1);
  });
});
