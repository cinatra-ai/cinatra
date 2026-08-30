// @vitest-environment jsdom
//
// THE ISLAND'S HALF OF THE HEIGHT CONTRACT (cinatra#3047).
//
// The card that frames this document sizes its frame from a height the document
// reports about itself, and withholds Expand when the reading already fits the
// collapsed box. The card's own suite
// (`packages/agents/src/__tests__/review-island-frame-height.test.tsx`) posts
// those messages by hand, so it proves what the HOST does with a report and
// nothing about whether one is ever sent. This is the other half: what the
// document measures, when it says so, and — the case that turns a refusal back
// into the blank expanded panel — that a DENIAL reports too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  ReviewIslandHeightReport,
  REVIEW_ISLAND_HEIGHT_MESSAGE,
} from "../island-height-report";

type Observed = { targets: Element[]; run: () => void };
let observers: Observed[] = [];

/** jsdom has no ResizeObserver; the component observes the root and its children. */
class StubResizeObserver {
  private readonly entry: Observed;
  constructor(cb: () => void) {
    this.entry = { targets: [], run: cb };
    observers.push(this.entry);
  }
  observe(target: Element) {
    this.entry.targets.push(target);
  }
  disconnect() {
    observers = observers.filter((o) => o !== this.entry);
  }
  unobserve() {}
}

/** jsdom has no layout: every rect this measurement reads is stated here. */
function withRect(el: Element, top: number, height: number) {
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

const posted: Array<{ marker?: unknown; height?: unknown }> = [];

beforeEach(() => {
  posted.length = 0;
  observers = [];
  vi.stubGlobal("ResizeObserver", StubResizeObserver as unknown as typeof ResizeObserver);
  // A document INSIDE a frame — the only shape that reports at all.
  Object.defineProperty(window, "parent", {
    configurable: true,
    value: {
      postMessage: (data: { marker?: unknown; height?: unknown }) => posted.push(data),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "parent", { configurable: true, value: window });
});

/** The reading's root, as the page draws it, with the reporter inside. */
function renderBody(children: Array<{ top: number; height: number }>) {
  const view = render(
    <div data-conformance-id="review-target-island-body">
      <ReviewIslandHeightReport />
      {children.map((_, i) => (
        <section key={i} data-child={i} />
      ))}
    </div>,
  );
  const root = view.container.querySelector('[data-conformance-id="review-target-island-body"]')!;
  withRect(root, 0, 10_000); // min-h-dvh: the ROOT is always at least the frame
  children.forEach((c, i) => withRect(root.querySelector(`[data-child="${i}"]`)!, c.top, c.height));
  return { view, root };
}

describe("the island reports the height of its CONTENT", () => {
  it("posts the lowest content edge, not the min-height ground it paints", () => {
    const { root } = renderBody([{ top: 0, height: 200 }, { top: 210, height: 130 }]);
    // Re-run the measurement now that the rects are stated.
    observers.forEach((o) => o.run());
    const last = posted.at(-1);
    expect(last?.marker).toBe(REVIEW_ISLAND_HEIGHT_MESSAGE);
    // 340, the reading — never the 10000 the root's own box measures.
    expect(last?.height).toBe(340);
    expect(root.getBoundingClientRect().height).toBe(10_000);
  });

  it("reports AGAIN when the content grows (a renderer that loads late)", () => {
    const { root } = renderBody([{ top: 0, height: 200 }]);
    observers.forEach((o) => o.run());
    expect(posted.at(-1)?.height).toBe(200);
    withRect(root.querySelector('[data-child="0"]')!, 0, 900);
    observers.forEach((o) => o.run());
    expect(posted.at(-1)?.height).toBe(900);
  });

  it("says nothing twice for a height that has not changed", () => {
    renderBody([{ top: 0, height: 200 }]);
    observers.forEach((o) => o.run());
    const count = posted.length;
    observers.forEach((o) => o.run());
    expect(posted.length).toBe(count);
  });

  it("A DENIAL REPORTS TOO, and what it reports fits the collapsed box", () => {
    // The empty island — the ONE element every refusal draws. It has no content
    // at all, and if it stayed silent the frame around it would keep its Expand
    // control and take the ceiling: an expanded panel of empty ground with only
    // its own control in it, which is exactly the graded defect.
    const view = render(
      <div data-conformance-id="review-target-island-empty">
        <ReviewIslandHeightReport />
      </div>,
    );
    const root = view.container.querySelector('[data-conformance-id="review-target-island-empty"]')!;
    withRect(root, 0, 10_000);
    observers.forEach((o) => o.run());
    const last = posted.at(-1);
    expect(last?.marker).toBe(REVIEW_ISLAND_HEIGHT_MESSAGE);
    expect(typeof last?.height).toBe("number");
    // Under the collapsed box the card draws (380), so the card offers no Expand.
    expect(last!.height as number).toBeGreaterThan(0);
    expect(last!.height as number).toBeLessThanOrEqual(380);
    // And it still draws nothing.
    expect(root.children.length).toBe(0);
  });

  it("says nothing at the TOP LEVEL, where there is no frame to tell", () => {
    Object.defineProperty(window, "parent", { configurable: true, value: window });
    renderBody([{ top: 0, height: 200 }]);
    observers.forEach((o) => o.run());
    expect(posted).toHaveLength(0);
  });
});
