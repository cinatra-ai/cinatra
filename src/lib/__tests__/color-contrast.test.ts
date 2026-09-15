/**
 * Colour maths behind the token contrast floors (cinatra#3107).
 *
 *   pnpm exec vitest run src/lib/__tests__/color-contrast.test.ts
 *
 * The readings this helper produces are the ones the design tokens are held to
 * in src/app/__tests__/control-border-contrast.test.ts, so the maths itself is
 * pinned against published reference values first: sRGB white on black is
 * 21:1, a colour against itself is 1:1, and the oklch notation the dark palette
 * is written in resolves to the sRGB the browser paints.
 */
import { describe, expect, it } from "vitest";

import {
  compositeOver,
  contrastAgainst,
  contrastRatio,
  oklchToRgb,
  parseCssColor,
  relativeLuminance,
} from "@/lib/color-contrast";

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

describe("parseCssColor", () => {
  it("reads the hex, rgb and rgba notations the light palette is written in", () => {
    expect(parseCssColor("#15213a")).toEqual({ r: 21, g: 33, b: 58, a: 1 });
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("rgb(241, 241, 237)")).toEqual({ r: 241, g: 241, b: 237, a: 1 });
    expect(parseCssColor("rgba(21, 33, 58, 0.14)")).toEqual({ r: 21, g: 33, b: 58, a: 0.14 });
  });

  it("reads the oklch notation the dark palette is written in, alpha included", () => {
    const opaque = parseCssColor("oklch(1 0 0)");
    expect(opaque).not.toBeNull();
    expect(Math.round(opaque!.r)).toBe(255);
    expect(opaque!.a).toBe(1);

    const alpha = parseCssColor("oklch(1 0 0 / 10%)");
    expect(alpha!.a).toBeCloseTo(0.1, 6);
  });

  it("returns null for a notation it does not model, so a caller fails loudly", () => {
    expect(parseCssColor("color-mix(in oklab, red 50%, blue)")).toBeNull();
  });
});

describe("oklchToRgb", () => {
  it("maps the palette's dark page ground to the sRGB a browser paints", () => {
    const bg = oklchToRgb(0.129, 0.042, 264.695);
    // Chromium resolves oklch(0.129 0.042 264.695) to about rgb(2, 6, 24).
    expect(Math.round(bg.r)).toBe(2);
    expect(Math.round(bg.g)).toBe(6);
    expect(Math.round(bg.b)).toBe(24);
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for white on black and 1:1 for a colour against itself", () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 10);
  });

  it("is symmetric", () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(contrastRatio(BLACK, WHITE), 10);
  });

  it("agrees with the published reading for #767676 on white (4.54:1)", () => {
    expect(contrastRatio(parseCssColor("#767676")!, WHITE)).toBeCloseTo(4.54, 2);
  });
});

describe("relativeLuminance", () => {
  it("brackets at 0 for black and 1 for white", () => {
    expect(relativeLuminance(BLACK)).toBeCloseTo(0, 10);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
  });
});

describe("compositeOver", () => {
  it("blends a translucent ink onto its ground and yields an opaque colour", () => {
    const out = compositeOver({ r: 255, g: 255, b: 255, a: 0.5 }, BLACK);
    expect(out).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
  });

  it("is a no-op for an opaque ink and yields the ground for a transparent one", () => {
    expect(compositeOver(WHITE, BLACK)).toEqual({ ...WHITE, a: 1 });
    expect(compositeOver({ ...WHITE, a: 0 }, BLACK)).toEqual({ ...BLACK, a: 1 });
  });
});

describe("contrastAgainst", () => {
  it("reads a translucent boundary at what the eye sees, not at the raw token", () => {
    // The defect shape of cinatra#3107: white at a low alpha over a dark ground
    // LOOKS like white and reads as almost nothing.
    const dim = contrastAgainst("oklch(1 0 0 / 10%)", "oklch(0.129 0.042 264.695)");
    expect(dim).toBeLessThan(1.5);
    const strengthened = contrastAgainst("oklch(1 0 0 / 40%)", "oklch(0.129 0.042 264.695)");
    expect(strengthened).toBeGreaterThanOrEqual(3);
  });

  it("throws on a colour notation it cannot resolve rather than guessing", () => {
    expect(() => contrastAgainst("var(--nope)", "#ffffff")).toThrow(/unsupported colour/i);
  });
});
