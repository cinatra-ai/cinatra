// @vitest-environment jsdom
//
// THE RE-CUT LEG'S TWO CARD-OWNED DEFECTS (the tenth proof round's grade on
// cinatra#3143, 2026-09-09: the counted defects).
//
// COUNTED DEFECT 1 — "all four dark frames: the displays draw a BLANK PLATE, not
// the work ... every dark CELL6 frame draws grey skeleton pulse bars and nothing
// else". The card names the host's palette ON the island address, and the
// island's load-state bag was keyed on that whole address — so switching the
// surface to dark rewrote the string, remounted the frame, and reset the bag to
// `loading`. The card then painted its skeleton over a document it had already
// drawn, which is the window every dark proof frame was shot in.
// `specs/app-artifact-review.html` §XI: "the display draws the named gap in the
// missing thing's place, never a blank plate and never a row appended beneath
// the work."
//
// COUNTED DEFECT 2 — "SIX pinned targets, TWO representation slots ... Four of
// six pinned targets draw no display at all". The card draws one header per
// pinned target and frames ONE island holding every target's panel, at a height
// fixed for a single target — so four of six panels sat below the frame's own
// fold with nothing on the card saying they were there.
// `specs/app-artifact-review.html` §IV: "Beneath the header sits the
// representation slot — the single region into which the artifact's type
// renderer mounts".

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { LifecycleCardState, LifecycleTargetHeader } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: "ref-recut-001" };

const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };

/** The palette class the app writes on a document root for each scheme. */
const ROOT_CLASS = { light: "cinatra", dark: "dark" } as const;

/** The one height the card frames a SINGLE pinned target at. */
const ONE_TARGET_HEIGHT = 380;

function headers(count: number): LifecycleTargetHeader[] {
  return Array.from({ length: count }, (_unused, i) => ({
    title: `Target ${i + 1}`,
    typeLabel: "Document",
    objectType: `@cinatra-ai/kind-${i + 1}:doc`,
    revisionId: `rev-00000000000000${i + 1}`,
    facts: ["Team", "Private"],
  }));
}

function mockResolve(targetHeaders: LifecycleTargetHeader[]): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state: PENDING,
          body: null,
          targetHeaders,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

function paintHost(scheme: "light" | "dark"): void {
  document.documentElement.className = ROOT_CLASS[scheme];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function mountCard() {
  return render(
    <LifecycleCardSurfaceProvider host="page_gate_region">
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

const islandIn = (container: HTMLElement): HTMLElement => {
  const island = container.querySelector<HTMLElement>(
    '[data-conformance-id="review-target-island"]',
  );
  if (!island) throw new Error("no island");
  return island;
};

const frameIn = (container: HTMLElement): HTMLIFrameElement => {
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("no island frame");
  return frame;
};

const skeletonIn = (container: HTMLElement) =>
  container.querySelector('[data-conformance-id="review-target-island-skeleton"]');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.className = "";
});

// ---------------------------------------------------------------------------
// COUNTED DEFECT 1 — the palette repaint may not blank the work.
// ---------------------------------------------------------------------------

describe("a palette repaint never draws a blank plate over work already on screen", () => {
  it("keeps the painted island painted when the surface goes dark", async () => {
    paintHost("light");
    mockResolve(headers(1));
    const { container } = mountCard();
    await settle();

    // The island arrives, and the frame paints.
    await act(async () => {
      fireEvent.load(frameIn(container));
    });
    expect(islandIn(container).getAttribute("data-island-load-state")).toBe("loaded");
    expect(frameIn(container).getAttribute("src")).toContain("scheme=light");
    expect(skeletonIn(container)).toBeNull();

    // The reader switches the surface to dark. The island follows the host...
    await act(async () => {
      paintHost("dark");
      await Promise.resolve();
    });
    await settle();
    expect(frameIn(container).getAttribute("src")).toContain("scheme=dark");

    // ...and the work stays on screen while it repaints. THE SETTLED DARK DOM
    // HOLDS NO SKELETON.
    expect(islandIn(container).getAttribute("data-island-load-state")).toBe("loaded");
    expect(skeletonIn(container)).toBeNull();
  });

  it("still draws the skeleton for a target that has never painted", async () => {
    paintHost("dark");
    mockResolve(headers(1));
    const { container } = mountCard();
    await settle();

    // Nothing has loaded yet — this is the window the skeleton exists for, and
    // it is the only one.
    expect(islandIn(container).getAttribute("data-island-load-state")).toBe("loading");
    expect(skeletonIn(container)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// COUNTED DEFECT 2 — six pinned targets draw six representation slots, not two.
// ---------------------------------------------------------------------------

describe("every pinned target gets a representation slot on the card", () => {
  for (const count of [1, 2, 6]) {
    it(`frames ${count} pinned target(s) at ${count} target-heights`, async () => {
      paintHost("light");
      mockResolve(headers(count));
      const { container } = mountCard();
      await settle();

      // One header per pinned target — the card's reading of the pinned set.
      expect(
        container.querySelectorAll('[data-conformance-id="review-target-header"]').length,
      ).toBe(count);

      // And room for one representation slot per header beneath them: the frame
      // is the region every panel is drawn in, so a frame that fits two of six
      // is four targets that "draw no display at all".
      expect(frameIn(container).style.height).toBe(`${ONE_TARGET_HEIGHT * count}px`);
    });
  }
});
