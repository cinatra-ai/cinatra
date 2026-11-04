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
// six pinned targets draw no display at all". The card then drew one header per
// pinned target and framed ONE island holding every target's panel, at a height
// fixed for a single target — so four of six panels sat below the frame's own
// fold with nothing on the card saying they were there. (A pending gate that
// pins several targets now frames each in its own island, cinatra#4129.)
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

/** The floor the frame holds while the island document has reported nothing. */
const ISLAND_MIN_HEIGHT = 380;

/** The message the island document names its own rendered height with. */
const HEIGHT_MESSAGE_TYPE = "cinatra.review-island.height";

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
          // Every target the gate pins is named: the route says so beside the headers.
          targetHeadersComplete: true,
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

/** Every island on the card, in pinned order — one per pinned target. */
const islandsIn = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-conformance-id="review-target-island"]'));

/** Every island frame on the card, in pinned order. */
const framesIn = (container: HTMLElement): HTMLIFrameElement[] =>
  Array.from(container.querySelectorAll("iframe"));

const frameIn = (container: HTMLElement, index = 0): HTMLIFrameElement => {
  const frame = framesIn(container)[index];
  if (!frame) throw new Error(`no island frame ${index + 1}`);
  return frame;
};

const skeletonIn = (container: HTMLElement) =>
  container.querySelector('[data-conformance-id="review-target-island-skeleton"]');

/** One island document naming the height it actually drew. */
async function islandReports(frame: HTMLIFrameElement, height: number): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: HEIGHT_MESSAGE_TYPE, height },
        origin: window.location.origin,
        source: frame.contentWindow,
      }),
    );
    await Promise.resolve();
  });
}

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

  it("keeps every painted island of a gate drawn as pairs painted when the surface goes dark", async () => {
    paintHost("light");
    mockResolve(headers(2));
    const { container } = mountCard();
    await settle();

    // One island per pinned target (cinatra#4129), each painted.
    expect(framesIn(container)).toHaveLength(2);
    await act(async () => {
      for (const frame of framesIn(container)) fireEvent.load(frame);
    });
    expect(islandsIn(container).map((island) => island.getAttribute("data-island-load-state"))).toEqual([
      "loaded",
      "loaded",
    ]);

    await act(async () => {
      paintHost("dark");
      await Promise.resolve();
    });
    await settle();

    // EVERY island stays on screen while it repaints, the second as the first.
    const repainted = framesIn(container);
    expect(repainted).toHaveLength(2);
    for (const frame of repainted) expect(frame.getAttribute("src")).toContain("scheme=dark");
    expect(islandsIn(container).map((island) => island.getAttribute("data-island-load-state"))).toEqual([
      "loaded",
      "loaded",
    ]);
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

// SUPERSEDED IN ITS MECHANISM, KEPT IN ITS MEANING (the twelfth proof round's
// counted defect, 2026-09-10). This round fixed the four missing slots with a
// constant per pinned target; the round after it measured that a constant is
// also what drew ~508px of empty panel on one route and clipped the sixth
// target's body on the other. The defect these readings guard is unchanged —
// every pinned target's panel is inside the frame — but the frame is now as
// tall as the island document says its work is, so that is what they read.
// And since cinatra#4129 a pending gate that pins several targets frames each
// target in its OWN island, under its own header: the representation slot of
// every pinned target is its own frame, sized by its own document, so these
// readings read every frame, never the first one alone.
// `review-gate-card.island-height.test.tsx` carries the height contract itself.
describe("every pinned target gets a representation slot on the card", () => {
  for (const count of [1, 2, 6]) {
    it(`frames ${count} pinned target(s), each at the height its own island reports`, async () => {
      paintHost("light");
      mockResolve(headers(count));
      const { container } = mountCard();
      await settle();

      // One header per pinned target — the card's reading of the pinned set.
      expect(
        container.querySelectorAll('[data-conformance-id="review-target-header"]').length,
      ).toBe(count);

      // One representation slot per header: a frame per pinned target, so no
      // target "draws no display at all" — and each frame as tall as its own
      // document's work, so none is clipped and none draws empty panel. The
      // first target's work is shorter than the floor.
      expect(framesIn(container)).toHaveLength(count);
      const drawn = Array.from({ length: count }, (_unused, index) => 324 + 100 * index);
      for (let index = 0; index < count; index += 1) {
        await islandReports(frameIn(container, index), drawn[index]);
      }
      expect(framesIn(container).map((frame) => frame.style.height)).toEqual(
        drawn.map((height) => `${Math.max(ISLAND_MIN_HEIGHT, height)}px`),
      );
    });
  }
});
