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
// ONE FRAME PER PINNED TARGET (cinatra#4129). A pending gate that pins several
// targets draws each target's header above its own island frame, so there is a
// frame per target and each one is sized by ITS OWN document's report: every
// reading below reads every frame, never the first one alone, and a report from
// one target's document never sizes a sibling's frame.
//
//   1. every frame's height equals its own island document's reported height
//      for 1, 2 and 6 targets (RED at dee3991d, where it equals 380 × the count);
//   2. no target body is clipped — each reported content height is never
//      greater than its frame's height once the report has settled;
//   3. a dark-palette island paints the same rows as light at the same scroll
//      offset — the repaint keeps each reported height rather than falling back
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

/** A real content height for each pinned target's own document, in pinned
 *  order — none a multiple of the old constant, and no two alike, so a frame
 *  sized by a sibling's report reads wrong. */
const REPORTED = [412, 913, 1772, 506, 644, 1031] as const;

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

/** Every island frame on the card, in pinned order — one per pinned target. */
const framesIn = (container: HTMLElement): HTMLIFrameElement[] =>
  Array.from(container.querySelectorAll("iframe"));

const frameIn = (container: HTMLElement, index = 0): HTMLIFrameElement => {
  const frame = framesIn(container)[index];
  if (!frame) throw new Error(`no island frame ${index + 1}`);
  return frame;
};

const frameHeightIn = (frame: HTMLIFrameElement): number => Number.parseFloat(frame.style.height);

/** THE ISLAND SPEAKS. One number, posted by one island document at its own
 *  origin — exactly the shape the reporter inside the island sends. */
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
// 1 — the frame is as tall as the island says it is, whatever the pinned count.
// ---------------------------------------------------------------------------

describe("each frame's height is its own island document's reported height", () => {
  for (const count of [1, 2, 6]) {
    it(`sizes each of the ${count} frame(s) at the height its own island reports`, async () => {
      paintHost("light");
      mockResolve(headers(count));
      const { container } = mountCard();
      await settle();

      // One header per pinned target — the card's reading of the pinned set is
      // unchanged; only the frame's height stops being derived from it. And one
      // frame per pinned target, each under its own header (cinatra#4129).
      expect(
        container.querySelectorAll('[data-conformance-id="review-target-header"]').length,
      ).toBe(count);
      expect(framesIn(container)).toHaveLength(count);
      await act(async () => {
        for (const frame of framesIn(container)) fireEvent.load(frame);
      });

      // Each document speaks for its own frame, the last first, so a frame that
      // took a sibling's report would hold the wrong number.
      for (let index = count - 1; index >= 0; index -= 1) {
        await islandReports(frameIn(container, index), REPORTED[index]);
      }

      const frames = framesIn(container);
      expect(frames).toHaveLength(count);
      frames.forEach((frame, index) => {
        expect(frame.style.height).toBe(`${REPORTED[index]}px`);
        expect(frameHeightIn(frame)).not.toBe(OLD_PER_TARGET_CONSTANT * count);
      });
    });
  }

  it("holds a sane floor in every frame until its island has reported anything", async () => {
    paintHost("light");
    mockResolve(headers(6));
    const { container } = mountCard();
    await settle();
    const frames = framesIn(container);
    expect(frames).toHaveLength(6);
    for (const frame of frames) expect(frame.style.height).toBe(`${ISLAND_MIN_HEIGHT}px`);
  });

  it("keeps the floor when the island reports less than it", async () => {
    paintHost("light");
    mockResolve(headers(1));
    const { container } = mountCard();
    await settle();
    await islandReports(frameIn(container), 120);
    expect(frameIn(container).style.height).toBe(`${ISLAND_MIN_HEIGHT}px`);
  });

  it("ignores a height that did not come from this frame's own document", async () => {
    paintHost("light");
    mockResolve(headers(6));
    const { container } = mountCard();
    await settle();
    expect(framesIn(container)).toHaveLength(6);
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
          source: frameIn(container, 0).contentWindow,
        }),
      );
      await Promise.resolve();
    });
    const floored = framesIn(container);
    expect(floored).toHaveLength(6);
    for (const frame of floored) expect(frame.style.height).toBe(`${ISLAND_MIN_HEIGHT}px`);

    // A SIBLING'S DOCUMENT names its own frame's height and no other: the second
    // target's report sizes the second frame alone.
    await islandReports(frameIn(container, 1), REPORTED[1]);
    const sized = framesIn(container);
    expect(sized).toHaveLength(6);
    sized.forEach((frame, index) => {
      expect(frame.style.height).toBe(index === 1 ? `${REPORTED[1]}px` : `${ISLAND_MIN_HEIGHT}px`);
    });
  });
});

// ---------------------------------------------------------------------------
// 2 — nothing is clipped, and nothing is empty.
// ---------------------------------------------------------------------------

describe("no target body is clipped and no empty panel is drawn", () => {
  it("leaves each island's whole content inside its frame, with no tail beneath it", async () => {
    paintHost("light");
    mockResolve(headers(6));
    const { container } = mountCard();
    await settle();
    expect(framesIn(container)).toHaveLength(6);
    await act(async () => {
      for (const frame of framesIn(container)) fireEvent.load(frame);
    });

    // Each island document's own scrollHeight, as its reporter measures it.
    for (let index = 0; index < 6; index += 1) {
      await islandReports(frameIn(container, index), REPORTED[index]);
    }

    const reported = framesIn(container);
    expect(reported).toHaveLength(6);
    reported.forEach((frame, index) => {
      const islandScrollHeight = REPORTED[index];
      // NOT GREATER THAN ITS FRAME — this target's body ends inside it, the
      // sixth's included.
      expect(islandScrollHeight).toBeLessThanOrEqual(frameHeightIn(frame));
      // AND NOT LESS — the 508px of empty panel the twelfth round measured is
      // exactly this difference, and it is zero in every frame.
      expect(frameHeightIn(frame) - islandScrollHeight).toBe(0);
    });
  });

  it("follows each island down when its content settles shorter", async () => {
    paintHost("light");
    mockResolve(headers(6));
    const { container } = mountCard();
    await settle();
    expect(framesIn(container)).toHaveLength(6);
    for (let index = 0; index < 6; index += 1) {
      await islandReports(frameIn(container, index), 2280);
      await islandReports(frameIn(container, index), REPORTED[index]);
    }
    const settled = framesIn(container);
    expect(settled).toHaveLength(6);
    settled.forEach((frame, index) => {
      expect(frame.style.height).toBe(`${REPORTED[index]}px`);
    });
  });
});

// ---------------------------------------------------------------------------
// 3 — the dark palette paints the same rows as light, at the same offset.
// ---------------------------------------------------------------------------

describe("a dark-palette island paints the same rows as light at the same scroll offset", () => {
  it("keeps every reported height across the palette repaint", async () => {
    paintHost("light");
    mockResolve(headers(6));
    const { container } = mountCard();
    await settle();
    expect(framesIn(container)).toHaveLength(6);
    await act(async () => {
      for (const frame of framesIn(container)) fireEvent.load(frame);
    });
    for (let index = 0; index < 6; index += 1) {
      await islandReports(frameIn(container, index), REPORTED[index]);
    }

    const light = framesIn(container).map((frame) => frame.style.height);
    expect(light).toEqual(REPORTED.map((height) => `${height}px`));
    for (const frame of framesIn(container)) expect(frame.getAttribute("src")).toContain("scheme=light");

    // The reader switches the surface to dark. Each island follows the host, on
    // the SAME identity — so no frame is remounted and the height each island
    // already reported is not thrown away.
    await act(async () => {
      paintHost("dark");
      await Promise.resolve();
    });
    await settle();

    const frames = framesIn(container);
    expect(frames).toHaveLength(6);
    for (const frame of frames) expect(frame.getAttribute("src")).toContain("scheme=dark");
    // THE SAME BOXES, so the same rows sit at the same offset in both palettes:
    // a tail that draws nothing in dark where light draws ink is a tail no
    // frame has any longer.
    expect(frames.map((frame) => frame.style.height)).toEqual(light);
    for (const frame of frames) expect(frameHeightIn(frame)).not.toBe(OLD_PER_TARGET_CONSTANT * 6);
  });
});
