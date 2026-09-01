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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

/**
 * IS THE CARD LISTENING YET?
 *
 * The card takes the island's height from a `message` listener it attaches in a
 * PASSIVE effect — work React flushes after the commit that puts the frame in
 * the document. So the frame being there is not the card being ready for a
 * height, and a report posted in that gap reaches a window nothing is listening
 * on and is dropped in silence: not a height the card refused, but a height
 * this file never delivered — which is exactly what an un-applied height looks
 * like from the assertions.
 *
 * Rather than assume a drained queue implies an attached listener, the file
 * WATCHES THE REGISTRATION ITSELF and waits for it. That is an observable fact
 * about the card, true or false at any instant, and it holds whatever order a
 * scheduler chooses to run the work in.
 */
const realAddEventListener = window.addEventListener.bind(window);
const realRemoveEventListener = window.removeEventListener.bind(window);
let messageListeners = 0;

beforeEach(() => {
  messageListeners = 0;
  window.addEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === "message") messageListeners += 1;
    return (realAddEventListener as (...args: unknown[]) => void)(type, ...rest);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === "message") messageListeners -= 1;
    return (realRemoveEventListener as (...args: unknown[]) => void)(type, ...rest);
  }) as typeof window.removeEventListener;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.addEventListener = realAddEventListener as typeof window.addEventListener;
  window.removeEventListener = realRemoveEventListener as typeof window.removeEventListener;
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
  // THE COMMIT IS NOT THE SETTLED CARD. `waitFor` hands the frame back as soon
  // as it is in the document, while the listener that takes the island's height
  // is attached by a passive effect React flushes AFTER that commit. So wait for
  // the card to BE listening — the registration itself, observed above — and not
  // merely for a queue to look empty, which is a guess about a scheduler rather
  // than a fact about the card. Then drain what the resolve still had queued
  // behind it, so every report below lands on the card each test means to drive.
  await waitFor(() => {
    expect(messageListeners).toBeGreaterThan(0);
  });
  await act(async () => {});
  // And the frame this file holds must BE the frame the card is listening for.
  // A remount would leave this handle detached, and every report would then be
  // posted from a window the card no longer frames — a drop that reads as "the
  // card ignored the height" when it is a stale handle. Fail on the handle.
  expect(frame.isConnected).toBe(true);
  return { view, frame };
}

/**
 * What the island posts about itself — from the window the card framed.
 *
 * Awaited, and settled on React's own completion rather than a clock: the
 * dispatch, whatever state the card takes from it and the effects that follow
 * are all drained before the caller reads the card back — and the card is known
 * to be listening before any of this is posted. So what each test
 * asserts is the card's ANSWER to the report — the frame it sized, the control
 * it does or does not offer — and never the card still mid-flight toward it.
 */
async function reportHeight(frame: HTMLIFrameElement, height: number, from?: Window | null) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { marker: "cinatra:review-island-height", height },
        source: (from === undefined ? frame.contentWindow : from) as Window,
      }),
    );
  });
  expect(frame.isConnected).toBe(true);
  expect(messageListeners).toBeGreaterThan(0);
}

const toggle = (view: { container: HTMLElement }) =>
  view.container.querySelector<HTMLButtonElement>('[data-action="toggle-review-target-height"]');

describe("the review target's frame follows the reading it holds", () => {
  it("expands to the READING's own height, not a fixed ceiling with empty ground", async () => {
    const { view, frame } = await renderCard();
    // A real reading, measured live on this defect's reproduction: the target
    // panel is ~340px inside a frame that was being given 760.
    await reportHeight(frame, 512);

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
    await reportHeight(frame, 5000);
    fireEvent.click(toggle(view)!);
    await waitFor(() => {
      expect(frame.style.height).toBe(`${CEILING}px`);
    });
  });

  it("never expands to LESS than the collapsed box", async () => {
    const { view, frame } = await renderCard();
    // Just over the clamp, so the control is still offered.
    await reportHeight(frame, CLAMPED + 1);
    fireEvent.click(toggle(view)!);
    await waitFor(() => {
      expect(frame.style.height).toBe(`${CLAMPED + 1}px`);
    });
    expect(Number.parseInt(frame.style.height, 10)).toBeGreaterThanOrEqual(CLAMPED);
  });

  it("offers NO expand control for a reading that already fits its box", async () => {
    const { view, frame } = await renderCard();
    expect(toggle(view)).not.toBeNull(); // unknown height keeps the control
    await reportHeight(frame, 240);
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
    await reportHeight(frame, 240, window);
    fireEvent.click(toggle(view)!);
    await waitFor(() => {
      expect(frame.style.height).toBe(`${CEILING}px`);
    });
    expect(toggle(view)).not.toBeNull();
  });

  it("ignores a height that is not a usable number", async () => {
    const { view, frame } = await renderCard();
    await reportHeight(frame, Number.NaN);
    await reportHeight(frame, -10);
    fireEvent.click(toggle(view)!);
    await waitFor(() => {
      expect(frame.style.height).toBe(`${CEILING}px`);
    });
  });
});
