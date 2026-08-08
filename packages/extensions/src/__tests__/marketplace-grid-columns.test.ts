/**
 * Marketplace listing-grid column contract (cinatra#2495).
 *
 * The grid's rendered class list and the numbers every geometry assertion is
 * written against live in two different files — the class list has to be a
 * literal string in the TSX for Tailwind's source scanner to emit the
 * utilities, and the numbers have to be importable from a module the
 * `"use client"` component's `next/navigation` import does not poison. This
 * suite is the seam between them: it fails if either side drifts.
 *
 * It pins three things:
 *
 *   1. the container-query class list encodes EXACTLY the steps in
 *      `marketplace-grid-columns.ts` — same thresholds, same counts, no extra
 *      step, none missing;
 *   2. no VIEWPORT breakpoint sizes the grid any more (the actual #2495
 *      regression guard — `sm:grid-cols-2` etc. coming back would restore
 *      viewport sizing while every container-derived assertion still passed);
 *   3. the container-derived column/width functions reproduce the pinned
 *      drawing's own arrangement when handed the drawing's own container width.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_GRID_BASE_COLUMNS,
  MARKETPLACE_GRID_COLUMN_STEPS,
  MARKETPLACE_GRID_CONTAINER_NAME,
  MARKETPLACE_GRID_GAP_PX,
  SPEC_DRAWN_CARD_WIDTH_PX,
  SPEC_DRAWN_COLUMNS,
  SPEC_DRAWN_CONTAINER_WIDTH_PX,
  SPEC_DRAWN_GAP_PX,
  marketplaceGridCardWidth,
  marketplaceGridColumns,
} from "../screens/marketplace-grid-columns";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_SOURCE = readFileSync(
  join(__dirname, "..", "screens", "extensions-marketplace-client.tsx"),
  "utf8",
);

/**
 * The whitespace-delimited class TOKENS of the element carrying
 * `data-testid="marketplace-grid"`. Tokenized rather than substring-matched:
 * `toContain("grid-cols-1")` also accepts `grid-cols-10`, and `"gap-4"` also
 * accepts `gap-40`.
 */
function gridClassTokens(): string[] {
  const match = CLIENT_SOURCE.match(/data-testid="marketplace-grid"\s*\n\s*className="([^"]+)"/);
  expect(match, "grid element with a literal className not found").toBeTruthy();
  return match![1]!.trim().split(/\s+/);
}

describe("marketplace listing grid — container-driven column contract (#2495)", () => {
  it("declares the named container the grid's variants resolve against", () => {
    // Presence only. That the container element is a genuine ANCESTOR of the
    // grid — the property that actually makes the queries resolve — is a DOM
    // fact, proven in the browser by the geometry suite
    // (`container.contains(grid)`), not inferrable from source order here.
    expect(CLIENT_SOURCE).toContain(`@container/${MARKETPLACE_GRID_CONTAINER_NAME}`);
  });

  it("encodes exactly the pinned steps as CONTAINER queries", () => {
    const found = gridClassTokens()
      .map((t) => t.match(/^@min-\[(\d+)px\]\/([a-z-]+):grid-cols-(\d+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({
        minContainerWidthPx: Number(m[1]),
        container: m[2],
        columns: Number(m[3]),
      }));

    expect(
      found.map(({ minContainerWidthPx, columns }) => ({ minContainerWidthPx, columns })),
    ).toEqual(
      MARKETPLACE_GRID_COLUMN_STEPS.map((s) => ({
        minContainerWidthPx: s.minContainerWidthPx,
        columns: s.columns,
      })),
    );
    for (const step of found) {
      expect(step.container).toBe(MARKETPLACE_GRID_CONTAINER_NAME);
    }
  });

  it("carries the base column count and the gap the contract assumes", () => {
    const tokens = gridClassTokens();
    expect(tokens).toContain(`grid-cols-${MARKETPLACE_GRID_BASE_COLUMNS}`);
    // gap-4 === 1rem === 16px. The width math divides the container by the
    // column count MINUS these gaps, so a gap change that skipped the constant
    // would silently shift every expected card width.
    expect(tokens).toContain("gap-4");
    expect(MARKETPLACE_GRID_GAP_PX).toBe(16);
  });

  it("sizes off NO viewport breakpoint (the #2495 regression guard)", () => {
    // Plain `sm:` / `md:` / `lg:` / `xl:` / `2xl:` variants are viewport media
    // queries; the `@`-prefixed forms above are container queries and are the
    // only ones allowed to drive this grid's columns.
    const viewportSized = gridClassTokens().filter((t) =>
      /^(sm|md|lg|xl|2xl):grid-cols-/.test(t),
    );
    expect(viewportSized).toEqual([]);
  });
});

describe("marketplaceGridColumns / marketplaceGridCardWidth", () => {
  it("steps at the pinned thresholds and nowhere else", () => {
    expect(marketplaceGridColumns(0)).toBe(1);
    expect(marketplaceGridColumns(639)).toBe(1);
    expect(marketplaceGridColumns(640)).toBe(2);
    expect(marketplaceGridColumns(1023)).toBe(2);
    expect(marketplaceGridColumns(1024)).toBe(3);
    expect(marketplaceGridColumns(1279)).toBe(3);
    expect(marketplaceGridColumns(1280)).toBe(4);
    expect(marketplaceGridColumns(4000)).toBe(4);
  });

  it("splits the container into equal tracks minus the gaps", () => {
    // 2 columns: (800 − 1×16) / 2.
    expect(marketplaceGridCardWidth(800)).toBeCloseTo(392, 5);
    // 4 columns: (1280 − 3×16) / 4.
    expect(marketplaceGridCardWidth(1280)).toBeCloseTo(308, 5);
  });

  it("reproduces the pinned drawing's arrangement at the drawing's own width", () => {
    // The drawing's numbers are self-consistent: 3 × 352 + 2 × 14 = 1084.
    expect(
      SPEC_DRAWN_COLUMNS * SPEC_DRAWN_CARD_WIDTH_PX + (SPEC_DRAWN_COLUMNS - 1) * SPEC_DRAWN_GAP_PX,
    ).toBe(SPEC_DRAWN_CONTAINER_WIDTH_PX);

    // Handed that container width, the app grid answers the DRAWN column
    // count, at the drawn card width up to the app's 16px gap vs the drawing's
    // 14px (2 gaps × 2px, spread over 3 tracks = 1.33px per card). Under
    // viewport sizing this width could have produced anything from 1 to 4
    // columns depending only on how wide the window happened to be.
    expect(marketplaceGridColumns(SPEC_DRAWN_CONTAINER_WIDTH_PX)).toBe(SPEC_DRAWN_COLUMNS);
    const delta =
      ((MARKETPLACE_GRID_GAP_PX - SPEC_DRAWN_GAP_PX) * (SPEC_DRAWN_COLUMNS - 1)) /
      SPEC_DRAWN_COLUMNS;
    expect(marketplaceGridCardWidth(SPEC_DRAWN_CONTAINER_WIDTH_PX)).toBeCloseTo(
      SPEC_DRAWN_CARD_WIDTH_PX - delta,
      5,
    );
  });
});
