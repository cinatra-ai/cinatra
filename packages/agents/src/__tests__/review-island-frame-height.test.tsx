// @vitest-environment jsdom
//
// THE EXPANDED FRAME IS THE READING'S OWN HEIGHT (cinatra#3047).
//
// THE DEFECT. Expanding set the frame to a FIXED 760px whatever the reviewed
// target's document measured. A target is usually shorter than that, so the
// press added empty ground under the reading and pushed the frame's own control
// 380px further down the page — and a reader who scrolled to that control was
// then looking at the ground, with the target's header, chip and revision line
// scrolled out above it. Nothing was wrong with the document; the part of the
// frame a reader could see had nothing in it.
//
// So the island now reports its own content height and the card sizes the frame
// from it, clamped between the collapsed box and the drawing's ceiling — and a
// target that already fits its box is offered no Expand at all, because there is
// nothing to expand into and a control that cannot act fails on press.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const REF = "ref-3047-height";
const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: REF };
const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };

/** The clamped and expanded box the drawing fixes. */
const CLAMPED = 380;
const CEILING = 760;

function mockResolve() {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ kind: "artifact_review_gate", state: PENDING, body: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

async function renderCard() {
  mockResolve();
  const view = render(
    <LifecycleCardSurfaceProvider host="page_gate_region">
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
  const frame = await waitFor(() => {
    const el = view.container.querySelector("iframe");
    if (!el) throw new Error("no island frame");
    return el as HTMLIFrameElement;
  });
  return { view, frame };
}

/** What the island posts about itself — from the window the card framed. */
function reportHeight(frame: HTMLIFrameElement, height: number, from?: Window | null) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { marker: "cinatra:review-island-height", height },
        source: (from === undefined ? frame.contentWindow : from) as Window,
      }),
    );
  });
}

const toggle = (view: { container: HTMLElement }) =>
  view.container.querySelector<HTMLButtonElement>('[data-action="toggle-review-target-height"]');

describe("the review target's frame follows the reading it holds", () => {
  it("expands to the READING's own height, not a fixed ceiling with empty ground", async () => {
    const { view, frame } = await renderCard();
    // A real reading, measured live on this defect's reproduction: the target
    // panel is ~340px inside a frame that was being given 760.
    reportHeight(frame, 512);

    const control = toggle(view);
    expect(control).not.toBeNull();
    fireEvent.click(control!);

    await waitFor(() => {
      expect(frame.style.height).toBe("512px");
    });
    expect(frame.style.height).not.toBe(`${CEILING}px`);
  });

  it("never expands past the ceiling, however tall the island says it is", async () => {
    const { view, frame } = await renderCard();
    reportHeight(frame, 5000);
    fireEvent.click(toggle(view)!);
    await waitFor(() => {
      expect(frame.style.height).toBe(`${CEILING}px`);
    });
  });

  it("never expands to LESS than the collapsed box", async () => {
    const { view, frame } = await renderCard();
    // Just over the clamp, so the control is still offered.
    reportHeight(frame, CLAMPED + 1);
    fireEvent.click(toggle(view)!);
    await waitFor(() => {
      expect(frame.style.height).toBe(`${CLAMPED + 1}px`);
    });
    expect(Number.parseInt(frame.style.height, 10)).toBeGreaterThanOrEqual(CLAMPED);
  });

  it("offers NO expand control for a reading that already fits its box", async () => {
    const { view, frame } = await renderCard();
    expect(toggle(view)).not.toBeNull(); // unknown height keeps the control
    reportHeight(frame, 240);
    await waitFor(() => {
      expect(toggle(view)).toBeNull();
    });
    // And the frame stays the collapsed box — no empty ground, ever.
    expect(frame.style.height).toBe(`${CLAMPED}px`);
  });

  it("keeps the ceiling when the island reports NOTHING (no behaviour lost)", async () => {
    const { view, frame } = await renderCard();
    fireEvent.click(toggle(view)!);
    await waitFor(() => {
      expect(frame.style.height).toBe(`${CEILING}px`);
    });
  });

  it("takes a height ONLY from the window this card framed", async () => {
    const { view, frame } = await renderCard();
    // Another frame on the page, or anything else posting the same shape.
    reportHeight(frame, 240, window);
    fireEvent.click(toggle(view)!);
    await waitFor(() => {
      expect(frame.style.height).toBe(`${CEILING}px`);
    });
    expect(toggle(view)).not.toBeNull();
  });

  it("ignores a height that is not a usable number", async () => {
    const { view, frame } = await renderCard();
    reportHeight(frame, Number.NaN);
    reportHeight(frame, -10);
    fireEvent.click(toggle(view)!);
    await waitFor(() => {
      expect(frame.style.height).toBe(`${CEILING}px`);
    });
  });
});
