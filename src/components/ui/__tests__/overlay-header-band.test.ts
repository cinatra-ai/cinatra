/**
 * Overlay panels are bounded away from the app-shell header band (cinatra#3105).
 *
 *   pnpm exec vitest run src/components/ui/__tests__/overlay-header-band.test.ts
 *
 * The select list, the dropdown menu and the popover all paint at `z-[160]`,
 * above the sticky `z-[140]` header, which is the intended stacking band. With
 * the positioning engine's default boundary (the viewport, zero padding) a list
 * taller than the room under its trigger simply grew across the header: the
 * breadcrumb was clipped and the top-bar control disappeared behind the panel.
 *
 * Two arms here. The first pins the ARITHMETIC of the bound — that it clears
 * the whole 4rem header band and the impersonation banner above it. The second
 * pins that the bound is set ONCE in the shared layer and that all three panel
 * families take it from there, which is what makes every call site inherit it.
 * The rendered geometry (a panel's top edge at or below the header's bottom
 * edge, in both themes) is asserted in the real DOM by
 * tests/e2e/design/conformance/overlay-header-band.spec.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  APP_HEADER_BAND_PX,
  OVERLAY_EDGE_GUTTER_PX,
  overlayCollisionPadding,
  readBannerHeightPx,
} from "@/lib/utils";

describe("overlayCollisionPadding", () => {
  it("keeps the whole header band clear, with room to spare", () => {
    const padding = overlayCollisionPadding(0);
    expect(padding.top).toBeGreaterThanOrEqual(APP_HEADER_BAND_PX);
    expect(padding.top).toBe(APP_HEADER_BAND_PX + OVERLAY_EDGE_GUTTER_PX);
  });

  it("adds the impersonation banner, which pushes the header further down", () => {
    expect(overlayCollisionPadding(44).top).toBe(APP_HEADER_BAND_PX + 44 + OVERLAY_EDGE_GUTTER_PX);
    expect(overlayCollisionPadding(44).top).toBeGreaterThan(overlayCollisionPadding(0).top);
  });

  it("gutters the other three sides without over-bounding them", () => {
    const padding = overlayCollisionPadding(0);
    expect(padding.right).toBe(OVERLAY_EDGE_GUTTER_PX);
    expect(padding.bottom).toBe(OVERLAY_EDGE_GUTTER_PX);
    expect(padding.left).toBe(OVERLAY_EDGE_GUTTER_PX);
  });

  it("ignores a missing or nonsense banner measurement instead of shrinking the bound", () => {
    expect(overlayCollisionPadding(Number.NaN).top).toBe(overlayCollisionPadding(0).top);
    expect(overlayCollisionPadding(-20).top).toBe(overlayCollisionPadding(0).top);
  });

  it("reads no banner where there is no document, so the server render is stable", () => {
    expect(readBannerHeightPx()).toBe(0);
  });
});

const PANELS: Array<[string, string]> = [
  ["select", "src/components/ui/select.tsx"],
  ["popover", "src/components/ui/popover.tsx"],
  ["dropdown menu", "src/components/ui/dropdown-menu.tsx"],
];

describe("the bound is set once, in the shared layer", () => {
  for (const [name, file] of PANELS) {
    it(`${name} content takes its collision padding from the shared helper`, () => {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(
        source,
        `${file} must import the shared bound rather than restate one`,
      ).toMatch(/import \{[^}]*overlayCollisionPadding[^}]*\} from ["']@\/lib\/utils["']/);
      expect(
        source,
        `${file} must pass collisionPadding, defaulting to the shared bound`,
      ).toContain("collisionPadding={collisionPadding ?? overlayCollisionPadding()}");
      expect(
        source,
        `${file} must keep collisionPadding overridable by a call site`,
      ).toMatch(/\n {2}collisionPadding,\n/);
    });
  }
});
