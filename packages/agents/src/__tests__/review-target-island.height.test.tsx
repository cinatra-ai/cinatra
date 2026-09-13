// @vitest-environment jsdom
//
// THE ISLAND IS THE HEIGHT OF WHAT IS IN IT (cinatra#3080, fix leg 6).
//
// THE DEFECT, MEASURED. Every one of the sixth reading's twelve frames carried
// one large empty bordered region under the reviewed target: 261.0 css px on the
// conversation frames, 271.5 on the review page's settled gate, 223.0 on the run
// page's verification reading — measured on the frames themselves, in both
// palettes, as the largest ink-free run inside the card column. It is the unused
// remainder of a box that was `ISLAND_HEIGHT_CLAMPED` tall whatever was inside
// it, and no drawing sentence puts it there.
//
// WHAT THE DRAWING DOES SAY. The gate's frame is enumerated — "the gate opens
// with a gate header …, then the review target, then the decision bar and the
// conversational prompt window" — and every frame in §XIII draws the pane ending
// where its content ends, with the floor (or the settled marker) immediately
// beneath it. The one size sentence the drawing gives is for a target that is
// too BIG: "a wide representation scrolls inside its own container rather than
// widening the page". So the ceiling stays and becomes a ceiling rather than a
// fixed height.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/review-target-island.height.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard, reviewIslandFrameHeight } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the height the island frame is given", () => {
  it("keeps the ceiling while nothing has been measured", () => {
    expect(reviewIslandFrameHeight(null)).toBe(380);
  });

  it("takes the document's own height when it is shorter than the ceiling", () => {
    // 184 is what the sixth reading's own target panel measured, border to
    // border, inside a box that stayed 380 tall.
    expect(reviewIslandFrameHeight(184)).toBe(184);
  });

  it("caps at the ceiling, so a tall representation scrolls inside its container", () => {
    expect(reviewIslandFrameHeight(2400)).toBe(380);
  });

  it("never collapses on a document that reports nothing usable", () => {
    expect(reviewIslandFrameHeight(0)).toBe(380);
    expect(reviewIslandFrameHeight(-10)).toBe(380);
    expect(reviewIslandFrameHeight(Number.NaN)).toBe(380);
    expect(reviewIslandFrameHeight(12)).toBe(120);
  });
});

const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: "ref-fix6-2" };

function mockResolve(state: unknown) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "artifact_review_gate", state, body: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

/**
 * The island's own document, as the frame is able to read it same-origin.
 *
 * THE ROOT IS THE FRAME'S OWN HEIGHT BY DEFAULT, because that is what a browser
 * reports: `documentElement` is the scrolling element and its `scrollHeight` is
 * never smaller than the viewport it scrolls in. jsdom models no such floor, so
 * a stub that gave the root the body's height would have hidden the one browser
 * behaviour that decides whether this leg works at all.
 */
function stubDocument(
  frame: HTMLIFrameElement,
  bodyHeight: number,
  rootHeight = 380,
) {
  const doc = {
    documentElement: { scrollHeight: rootHeight },
    body: { scrollHeight: bodyHeight },
  };
  Object.defineProperty(frame, "contentDocument", {
    configurable: true,
    get: () => doc,
  });
  return doc;
}

/** Records what a ResizeObserver was pointed at, and lets a test fire it. */
function recordResizeObserver() {
  const observed: unknown[] = [];
  const fire: Array<() => void> = [];
  const disconnected = { count: 0 };
  class Recording {
    constructor(callback: () => void) {
      fire.push(callback);
    }
    observe(target: unknown) {
      observed.push(target);
    }
    unobserve() {}
    disconnect() {
      disconnected.count += 1;
    }
  }
  vi.stubGlobal("ResizeObserver", Recording);
  return { observed, fire, disconnected };
}

describe("the island frame, at the real seam", () => {
  it("sizes itself to the island document once that document has loaded", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true } satisfies LifecycleCardState);
    const { container } = render(
      <LifecycleCardSurfaceProvider host="page_gate_region">
        <ReviewGateCard view={VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe") as HTMLIFrameElement;

    // Before the document is there, the ceiling — byte for byte what shipped.
    expect(frame.style.height).toBe("380px");

    // The root reports the frame's own height, as a browser's root scroller
    // does; the body reports what is actually in it.
    stubDocument(frame, 184, 380);
    fireEvent.load(frame);

    await waitFor(() => expect(frame.style.height).toBe("184px"));
  });

  it("re-measures when the island document grows after its load event", async () => {
    const observer = recordResizeObserver();
    mockResolve({ state: "pending", canDecide: true, canComment: true } satisfies LifecycleCardState);
    const { container, unmount } = render(
      <LifecycleCardSurfaceProvider host="page_gate_region">
        <ReviewGateCard view={VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const doc = stubDocument(frame, 184, 380);
    fireEvent.load(frame);
    await waitFor(() => expect(frame.style.height).toBe("184px"));

    // THE BODY IS WHAT IS WATCHED: it is the box that grows when a picture
    // decodes or a font swaps. A document stretched to its frame has a root box
    // that never changes, so an observer on the root alone would sleep through
    // exactly this.
    expect(observer.observed).toContain(doc.body);
    expect(observer.fire.length).toBeGreaterThan(0);

    doc.body.scrollHeight = 300;
    for (const callback of observer.fire) callback();
    await waitFor(() => expect(frame.style.height).toBe("300px"));

    unmount();
    expect(observer.disconnected.count).toBeGreaterThan(0);
  });

  it("keeps the ceiling for a document taller than it", async () => {
    mockResolve({ state: "settled", outcome: "changes_requested" } satisfies LifecycleCardState);
    const { container } = render(
      <LifecycleCardSurfaceProvider host="page_gate_region">
        <ReviewGateCard view={VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    stubDocument(frame, 1800, 1800);
    fireEvent.load(frame);
    await waitFor(() =>
      expect(
        container.querySelector('[data-island-load-state="loaded"]'),
      ).not.toBeNull(),
    );
    expect(frame.style.height).toBe("380px");
  });
});
