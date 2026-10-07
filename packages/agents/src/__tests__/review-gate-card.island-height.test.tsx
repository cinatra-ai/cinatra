// @vitest-environment jsdom
//
// THE ISLAND'S HEIGHT FOLLOWS ITS CONTENT (the twelfth proof round's counted
// defect on cinatra#3143, 2026-09-10).
//
// THE DEFECT. The re-cut sized the review island at ONE FIXED HEIGHT — one
// constant per pinned target — and that fits neither column: on the review
// route the island drew about 508 px of EMPTY panel below the last target's
// body, and on the run route the sixth target's body was CLIPPED mid-sentence
// at the island's bottom edge with no scroll. A constant cannot be both.
//
// `specs/app-artifact-review.html` §IV: "Beneath the header sits the
// representation slot — the single region into which the artifact's type
// renderer mounts". A slot whose bottom half is empty panel and a slot whose
// body is cut off are the same failure of that sentence from opposite sides.
//
// THE CONTRACT THESE THREE READINGS PIN. The island document reports its own
// rendered height to the host, and the host sizes the frame from that message —
// a sane floor while nothing has been reported, and no per-target constant ever
// again. So the frame ends exactly where the last body ends, on every route and
// in both palettes.
//
//   1. the frame height equals the island document's reported height for 1, 2
//      and 6 targets (RED at dee3991d, where it equals 380 × the count);
//   2. no target body is clipped — the reported content height is never greater
//      than the frame height once the report has settled;
//   3. a dark-palette island paints the same rows as light at the same scroll
//      offset — the repaint keeps the reported height rather than falling back
//      to the constant.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { LifecycleCardState, LifecycleTargetHeader } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: "ref-island-height" };
const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const ROOT_CLASS = { light: "cinatra", dark: "dark" } as const;

/** The message the island document names its own rendered height with — the
 *  client half of `src/app/lifecycle/review-island/island-height-report.ts`. */
const HEIGHT_MESSAGE_TYPE = "cinatra.review-island.height";

/** The floor the frame holds while the island has reported nothing. */
const ISLAND_MIN_HEIGHT = 380;

/** The height the OLD contract drew per pinned target. Named here only so the
 *  readings below can state that they are no longer it. */
const OLD_PER_TARGET_CONSTANT = 380;

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

const frameIn = (container: HTMLElement): HTMLIFrameElement => {
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("no island frame");
  return frame;
};

const frameHeightIn = (container: HTMLElement): number =>
  Number.parseFloat(frameIn(container).style.height);

/** THE ISLAND SPEAKS. One number, posted by the island document at its own
 *  origin — exactly the shape the reporter inside the island sends. */
async function islandReports(container: HTMLElement, height: number): Promise<void> {
  const frame = frameIn(container);
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
// 1 — the frame is as tall as the island says it is, whatever the pinned count.
// ---------------------------------------------------------------------------

describe("the frame height is the island document's own reported height", () => {
  // A real content height per pinned count — none of them a multiple of the
  // old per-target constant, because content is not a multiple of anything.
  for (const [count, reported] of [
    [1, 412],
    [2, 913],
    [6, 1772],
  ] as const) {
    it(`sizes the frame at the ${reported}px the island reports for ${count} target(s)`, async () => {
      paintHost("light");
      mockResolve(headers(count));
      const { container } = mountCard();
      await settle();
      await act(async () => {
        fireEvent.load(frameIn(container));
      });

      // One header per pinned target — the card's reading of the pinned set is
      // unchanged; only the frame's height stops being derived from it.
      expect(
        container.querySelectorAll('[data-conformance-id="review-target-header"]').length,
      ).toBe(count);

      await islandReports(container, reported);

      expect(frameIn(container).style.height).toBe(`${reported}px`);
      expect(frameHeightIn(container)).not.toBe(OLD_PER_TARGET_CONSTANT * count);
    });
  }

  it("holds a sane floor until the island has reported anything", async () => {
    paintHost("light");
    mockResolve(headers(6));
    const { container } = mountCard();
    await settle();
    expect(frameIn(container).style.height).toBe(`${ISLAND_MIN_HEIGHT}px`);
  });

  it("keeps the floor when the island reports less than it", async () => {
    paintHost("light");
    mockResolve(headers(1));
    const { container } = mountCard();
    await settle();
    await islandReports(container, 120);
    expect(frameIn(container).style.height).toBe(`${ISLAND_MIN_HEIGHT}px`);
  });

  it("ignores a height that did not come from this frame's own document", async () => {
    paintHost("light");
    mockResolve(headers(6));
    const { container } = mountCard();
    await settle();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: HEIGHT_MESSAGE_TYPE, height: 9999 },
          origin: window.location.origin,
          source: window,
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "some.other.message", height: 9999 },
          origin: window.location.origin,
          source: frameIn(container).contentWindow,
        }),
      );
      await Promise.resolve();
    });
    expect(frameIn(container).style.height).toBe(`${ISLAND_MIN_HEIGHT}px`);
  });
});

// ---------------------------------------------------------------------------
// 2 — nothing is clipped, and nothing is empty.
// ---------------------------------------------------------------------------

describe("no target body is clipped and no empty panel is drawn", () => {
  it("leaves the island's whole content inside the frame, with no tail beneath it", async () => {
    paintHost("light");
    mockResolve(headers(6));
    const { container } = mountCard();
    await settle();
    await act(async () => {
      fireEvent.load(frameIn(container));
    });

    // The island document's own scrollHeight, as its reporter measures it.
    const islandScrollHeight = 1772;
    await islandReports(container, islandScrollHeight);

    // NOT GREATER THAN THE FRAME — the sixth target's body ends inside it.
    expect(islandScrollHeight).toBeLessThanOrEqual(frameHeightIn(container));
    // AND NOT LESS — the 508px of empty panel the twelfth round measured is
    // exactly this difference, and it is zero.
    expect(frameHeightIn(container) - islandScrollHeight).toBe(0);
  });

  it("follows the island down when its content settles shorter", async () => {
    paintHost("light");
    mockResolve(headers(6));
    const { container } = mountCard();
    await settle();
    await islandReports(container, 2280);
    await islandReports(container, 1772);
    expect(frameIn(container).style.height).toBe("1772px");
  });
});

// ---------------------------------------------------------------------------
// 3 — the dark palette paints the same rows as light, at the same offset.
// ---------------------------------------------------------------------------

describe("a dark-palette island paints the same rows as light at the same scroll offset", () => {
  it("keeps the reported height across the palette repaint", async () => {
    paintHost("light");
    mockResolve(headers(6));
    const { container } = mountCard();
    await settle();
    await act(async () => {
      fireEvent.load(frameIn(container));
    });
    await islandReports(container, 1772);

    const light = frameIn(container).style.height;
    expect(light).toBe("1772px");
    expect(frameIn(container).getAttribute("src")).toContain("scheme=light");

    // The reader switches the surface to dark. The island follows the host, on
    // the SAME identity — so the frame is not remounted and the height the
    // island already reported is not thrown away.
    await act(async () => {
      paintHost("dark");
      await Promise.resolve();
    });
    await settle();

    expect(frameIn(container).getAttribute("src")).toContain("scheme=dark");
    // THE SAME BOX, so the same rows sit at the same offset in both palettes:
    // a tail that draws nothing in dark where light draws ink is a tail this
    // frame no longer has.
    expect(frameIn(container).style.height).toBe(light);
    expect(frameHeightIn(container)).not.toBe(OLD_PER_TARGET_CONSTANT * 6);
  });
});
