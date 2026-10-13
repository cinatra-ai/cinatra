// @vitest-environment jsdom
//
// TWO READINGS THE PICTURES RECORDED AS DEFECTS (cinatra#2853, the picture
// leg).
//
// 1. THE FRAMED TARGET DREW NOTHING. The dark frame's target window measured a
//    uniform RGB(13,24,42) box — the island's own ground, exactly — over
//    1430x430 with a standard deviation of 0.00: no content, no placeholder
//    bars and no "The preview did not load" line, while the DOM carried
//    `review-target-island-skeleton`. Plan (A) §4.1: the card "always shows you
//    something; it is never blank".
//
//    The cause is that `onLoad` was read as "the target arrived". Every denial
//    this island serves is an EMPTY painted rectangle — that shape is required,
//    so that a reader who may not see the item is indistinguishable from one
//    looking at an item that is not there — and `onLoad` fires for it exactly as
//    it does for a drawn target. The skeleton came down and the reader was left
//    looking at a flat panel.
//
// 2. THE SEVERAL-REVIEWS STATUS LINE DREW IN BODY INK. It carried
//    `text-mustard-ink`, which names no token this theme declares, so the
//    utility was never emitted and the line inherited the body colour. The one
//    state the drawing turns mustard looked identical to the two that are not.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import {
  LifecycleCardSurfaceProvider,
  LifecycleComposerFocusProvider,
  createComposerFocusStore,
} from "../lifecycle-card-runtime";
import {
  REVIEW_ISLAND_EMPTY_MARKER,
  ReviewGateCard,
  islandFrameServedTheDenial,
} from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-island-001",
};

function mockResolve(state: LifecycleCardState) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "artifact_review_gate", state, body: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function renderPending(state?: LifecycleCardState) {
  const resolved = state ?? { state: "pending" as const, canDecide: true, canComment: true };
  mockResolve(resolved);
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

// ---------------------------------------------------------------------------
// 1. The framed target is never a blank box
// ---------------------------------------------------------------------------

describe("the framed target is never blank", () => {
  it("the loading state draws the placeholder bars, with a ground token on each", async () => {
    const { container } = renderPending();
    const skeleton = await waitFor(() => {
      const el = container.querySelector('[data-conformance-id="review-target-island-skeleton"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // Bars, not an empty box: every one carries a height and a ground.
    const bars = Array.from(skeleton.querySelectorAll("div")).filter((d) =>
      d.className.includes("bg-surface-muted"),
    );
    expect(bars.length).toBeGreaterThanOrEqual(5);
    for (const bar of bars) {
      expect(bar.className).toMatch(/\bh-\d/);
      expect(bar.className).toContain("rounded");
    }
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
  });

  it("a frame that served the DENIAL is read as a preview that did not arrive", async () => {
    const { container } = renderPending();
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    // THE ISLAND'S DENIAL, standing in for the document jsdom will not fetch:
    // the card's whole question of the frame is one marker query, and this
    // answers it exactly as the served document does.
    Object.defineProperty(frame, "contentDocument", {
      configurable: true,
      get: () => ({
        querySelector: (selector: string) =>
          selector.includes(REVIEW_ISLAND_EMPTY_MARKER) ? ({} as Element) : null,
      }),
    });

    expect(islandFrameServedTheDenial(frame)).toBe(true);
    frame.dispatchEvent(new Event("load"));

    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="review-target-island-timeout"]'),
      ).not.toBeNull(),
    );
    expect(container.textContent).toContain("The preview did not load");
    // And the decision floor underneath is untouched by a preview that failed.
    expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull();
  });

  it("a frame that served a TARGET still paints, exactly as it always has", async () => {
    const { container } = renderPending();
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    expect(islandFrameServedTheDenial(frame)).toBe(false);
    frame.dispatchEvent(new Event("load"));

    await waitFor(() =>
      expect(container.querySelector('[data-island-load-state="loaded"]')).not.toBeNull(),
    );
    expect(
      container.querySelector('[data-conformance-id="review-target-island-timeout"]'),
    ).toBeNull();
  });

  it("fails towards the SHIPPED behaviour on anything it cannot read, and never throws", () => {
    expect(islandFrameServedTheDenial(null)).toBe(false);
    expect(
      islandFrameServedTheDenial({
        get contentDocument(): Document {
          throw new Error("cross-origin");
        },
      } as unknown as HTMLIFrameElement),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The several-reviews status line is a STATE, and looks like one
// ---------------------------------------------------------------------------

describe("the several-reviews status line", () => {
  async function renderWithTwoOpen() {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const store = createComposerFocusStore();
    // A second eligible card, so nothing is bound and the row is ambiguous.
    store.registerEligible("ref-some-other-review", async () => ({ ok: true, message: "" }));
    const rendered = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleComposerFocusProvider store={store}>
          <ReviewGateCard view={VIEW} />
        </LifecycleComposerFocusProvider>
      </LifecycleCardSurfaceProvider>,
    );
    const line = await waitFor(() => {
      const el = rendered.container.querySelector(
        '[data-conformance-id="review-composer-ambiguous"]',
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    return { ...rendered, line, store };
  }

  it("turns the STATE colour while more than one review is waiting to be chosen", async () => {
    const { line } = await renderWithTwoOpen();
    expect(line.textContent).toContain("More than one review is waiting");
    // The status palette's own mustard, and a token the theme actually declares.
    expect(line.className).toContain("text-warning");
    // `mustard-ink` is declared nowhere, so the utility was never emitted and
    // the line drew in the inherited body ink. It must not come back.
    expect(line.className).not.toContain("mustard-ink");
  });

  it("the two states that are NOT waiting on a choice keep the quiet treatment", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const store = createComposerFocusStore();
    // The reader gave the box back: one card open, nothing bound, nothing to
    // choose between — the third row of plan (A) 2.1's table.
    store.clearFocus();
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleComposerFocusProvider store={store}>
          <ReviewGateCard view={VIEW} />
        </LifecycleComposerFocusProvider>
      </LifecycleCardSurfaceProvider>,
    );
    const unbound = await waitFor(() => {
      const el = container.querySelector('[data-conformance-id="review-composer-unbound"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(unbound.className).toContain("text-muted-foreground");
    expect(unbound.className).not.toContain("text-warning");
  });
});
