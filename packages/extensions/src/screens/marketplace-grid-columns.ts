/**
 * Marketplace listing-grid column contract (cinatra#2495).
 *
 * WHAT CHANGED, AND WHAT DID NOT
 * ------------------------------
 * The grid's column COUNTS (1 / 2 / 3 / 4) and the THRESHOLDS at which they
 * step (640 / 1024 / 1280) are exactly the ones the grid has always carried —
 * they are the Tailwind `sm` / `lg` / `xl` values the class list used. The only
 * thing this contract changes is WHAT those thresholds are measured against:
 * the grid's own CONTAINER instead of the VIEWPORT.
 *
 * WHY
 * ---
 * The listing grid never occupies the viewport. It renders inside the app
 * shell, whose persistent sidebar (16rem expanded / 3rem collapsed) plus the
 * page gutters take a few hundred pixels off before the grid gets any width at
 * all. Sizing columns off the viewport therefore over-counted columns at every
 * real width and squeezed each card far below the drawn one — measured live on
 * `/configuration/marketplace` during cinatra#2488 round 2: 216px @800,
 * 260px @1100, 236px @1280, 276px @1440, against a drawn card of
 * {@link SPEC_DRAWN_CARD_WIDTH_PX}px. That squeeze is what forced #2488 to give
 * the footer meta row a wrap allowance so its content stopped being silently
 * sliced, and it is what the in-card install panel (cinatra#2373) inherits.
 *
 * THE DRAWN GEOMETRY THIS REPRODUCES
 * ----------------------------------
 * The pinned drawing (cinatra-ai/design `specs/app-extensions.html` §I at
 * commit ca118d4e27154b5a523aaa59609aaa631f70ce26) lays the listing grid out as
 * `grid-template-columns: 1fr 1fr 1fr; gap: 14px` inside a `.wrap` of
 * `max-width: 1180px; padding: 56px 48px` — a {@link SPEC_DRAWN_CONTAINER_WIDTH_PX}px
 * content box, so each drawn card is (1084 − 2×14) / 3 = 352px.
 *
 * Feed that same 1084px width to this contract and it answers 3 columns
 * (1084 ≥ 1024, < 1280) at (1084 − 2×16) / 3 = 350.67px per card — the drawn
 * arrangement at the drawn width, the 1.33px differing only because the app's
 * `gap-4` is 16px where the drawing uses 14px. Under viewport sizing the same
 * 1084px container could render anything from 1 to 4 columns depending on how
 * wide the window happened to be around it.
 *
 * Kept dependency-free ON PURPOSE: the client component that renders the grid
 * is `"use client"` and imports `next/navigation`, so neither the Playwright
 * geometry suite nor a node-environment unit test can import it. They import
 * THIS module instead, which is why the numbers a test asserts and the numbers
 * the grid renders cannot drift apart silently — the class list that encodes
 * them is pinned against these constants by
 * `packages/extensions/src/__tests__/marketplace-grid-columns.test.ts`.
 */

/** `gap-4` on the grid, in px — the spacing between adjacent cards. */
export const MARKETPLACE_GRID_GAP_PX = 16;

/** Columns below the first step (the base `grid-cols-1`). */
export const MARKETPLACE_GRID_BASE_COLUMNS = 1;

/**
 * Column steps, ascending by threshold. Each entry is a container inline-size
 * (px) at or above which the grid renders `columns` columns.
 *
 * These are the Tailwind `sm` (640) / `lg` (1024) / `xl` (1280) values the grid
 * already used — carried over unchanged, only re-pointed at the container.
 */
export const MARKETPLACE_GRID_COLUMN_STEPS = [
  { minContainerWidthPx: 640, columns: 2 },
  { minContainerWidthPx: 1024, columns: 3 },
  { minContainerWidthPx: 1280, columns: 4 },
] as const;

/** The Tailwind named container the grid's `@min-[…]` variants resolve against. */
export const MARKETPLACE_GRID_CONTAINER_NAME = "marketplace-grid";

/** Columns the grid renders for a given container inline-size. */
export function marketplaceGridColumns(containerWidthPx: number): number {
  let columns: number = MARKETPLACE_GRID_BASE_COLUMNS;
  for (const step of MARKETPLACE_GRID_COLUMN_STEPS) {
    if (containerWidthPx >= step.minContainerWidthPx) columns = step.columns;
  }
  return columns;
}

/**
 * The card width the grid produces for a given container inline-size: equal
 * `1fr` tracks minus the gaps between them.
 */
export function marketplaceGridCardWidth(containerWidthPx: number): number {
  const columns = marketplaceGridColumns(containerWidthPx);
  return (containerWidthPx - (columns - 1) * MARKETPLACE_GRID_GAP_PX) / columns;
}

// ---------------------------------------------------------------------------
// The pinned drawing's own numbers (specs/app-extensions.html §I @ ca118d4e).
// Restated here so the geometry suite can measure the render AGAINST the
// drawing without re-deriving it from the spec HTML at test time.
// ---------------------------------------------------------------------------

/** `.wrap` content box: 1180px max-width − 2 × 48px padding. */
export const SPEC_DRAWN_CONTAINER_WIDTH_PX = 1084;
/** `grid-template-columns: 1fr 1fr 1fr`. */
export const SPEC_DRAWN_COLUMNS = 3;
/** `gap: 14px`. */
export const SPEC_DRAWN_GAP_PX = 14;
/** (1084 − 2 × 14) / 3. */
export const SPEC_DRAWN_CARD_WIDTH_PX = 352;
