// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// AN ARRIVING READING IS NOT READ THROUGH THE COMPOSER (cinatra#3044, the
// eighth set's second defect).
// ---------------------------------------------------------------------------
// The ratified drawing composes §I's conversation as a stream with the composer
// at its foot, and §II says what happens when the run's own reading arrives in
// it: "The placeholder is replaced, in place, by the review. When the run's
// output is generated, the placeholder becomes the Review requested screen — the
// same slot, in the same turn. It happens on its own: the reader neither asks
// for the card nor presses anything to bring it."
//
// A reading that arrives on its own has to be READABLE on its own. The eighth
// graded set measured the opposite: the arriving reading drew UNDER the
// composer's opaque card, roughly 63 CSS px of it left above the composer's top
// edge.
//
// The cause is a constant. The stream reserved a fixed 96px for a composer whose
// real height is whatever the notice row above it and a wrapped prompt make it,
// so every pixel past 96 covered the newest content. This file pins the
// reservation to the composer's OWN measured box, on both hosts — and it pins
// what the fix may NOT be: the card is never lifted OVER the composer.
//
// Run:
//   cd packages/chat && pnpm exec vitest run \
//     src/__tests__/arriving-reading-clears-the-composer-3053.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => ({ state: "none" }),
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: async () => ({ state: "none" }),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: async () => [],
  getSkillsForAgentAction: async () => [],
  getFieldRendererContextForAgentBuilderAction: async () => ({}),
  confirmRunSkillSelectionAction: async () => ({ ok: true }),
}));
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => null,
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
vi.mock("../inline-agent-run-card", () => ({ InlineAgentRunCard: () => null }));

import {
  COMPOSER_RESERVED_SPACE_FLOOR_PX,
  composerReservedSpacePx,
} from "../composer-reserved-space";
import { SURFACES, mountSurface } from "./conversation-column-harness";

/** Every observer this file made, so a test can report a late layout. */
const observers: Array<() => void> = [];

class RecordingResizeObserver {
  constructor(callback: () => void) {
    observers.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  observers.length = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    RecordingResizeObserver;
});

afterEach(() => {
  cleanup();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

/** jsdom lays nothing out, so the composer's box is stated rather than grown. */
function statedHeight(element: HTMLElement, px: number): void {
  Object.defineProperty(element, "offsetHeight", {
    configurable: true,
    value: px,
  });
}

describe("the reservation the stream leaves for the composer", () => {
  it("is the composer's own height once there is one to measure", () => {
    expect(composerReservedSpacePx(184)).toBe(184);
    expect(composerReservedSpacePx(96.4)).toBe(97);
  });

  it("never falls below the reservation the column has always carried", () => {
    expect(composerReservedSpacePx(0)).toBe(COMPOSER_RESERVED_SPACE_FLOOR_PX);
    expect(composerReservedSpacePx(12)).toBe(COMPOSER_RESERVED_SPACE_FLOOR_PX);
    expect(composerReservedSpacePx(null)).toBe(COMPOSER_RESERVED_SPACE_FLOOR_PX);
    expect(composerReservedSpacePx(Number.NaN)).toBe(COMPOSER_RESERVED_SPACE_FLOOR_PX);
  });
});

describe.each(SURFACES)("on the %s host", (surface) => {
  it("places the arriving reading fully above the composer, never under it", async () => {
    const { container } = await mountSurface(surface);

    const stream = container.querySelector<HTMLElement>("[data-conversation-stream]");
    const composer = container.querySelector<HTMLElement>("[data-conversation-composer]");
    expect(stream).not.toBeNull();
    expect(composer).not.toBeNull();

    // A composer taller than the old constant: the notice row that names the
    // bound card, over a prompt that has wrapped.
    statedHeight(composer!, 184);
    act(() => {
      for (const fire of observers) fire();
    });

    await waitFor(() => {
      expect(stream!.style.paddingBottom).toBe("184px");
    });
    // THE CONSTANT IS GONE. A class that reserves a fixed height beside a
    // measured reservation is the defect waiting to come back.
    expect(stream!.className).not.toMatch(/\bpb-24\b/);
  });

  it("reserves the floor while the composer has not been laid out yet", async () => {
    const { container } = await mountSurface(surface);

    const stream = container.querySelector<HTMLElement>("[data-conversation-stream]");
    expect(stream!.style.paddingBottom).toBe(`${COMPOSER_RESERVED_SPACE_FLOOR_PX}px`);
  });

  it("lifts nothing over the composer — the stream is never re-stacked in front of it", async () => {
    const { container } = await mountSurface(surface);

    const stream = container.querySelector<HTMLElement>("[data-conversation-stream]");
    const composer = container.querySelector<HTMLElement>("[data-conversation-composer]");
    // The fix is reserved space. A z-order that put the stream in front would
    // draw the card OVER the composer, which is the other way of making it
    // unreadable.
    expect(stream!.style.zIndex).toBe("");
    expect(stream!.className).not.toMatch(/\bz-\d/);
    expect(composer!.className).not.toMatch(/\b-z-\d/);
  });
});
