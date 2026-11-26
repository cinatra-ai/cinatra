// @vitest-environment jsdom
//
// THE FRAME ENDS WHERE THE PDF FLOOR ENDS (cinatra#3459, the layout reading).
//
// The review card draws its target in a sandboxed frame, where the browser runs
// no PDF viewer, so a pdf target there is always the shared pdf shell's
// download floor: a sentence and a download, a short block that ends the panel.
// specs/app-artifact-review.html §XI preamble: "only an embedded viewer takes
// its height from the surface", and "never a blank plate". The frame used to
// hold its floor height (380px) under that block, leaving an empty area below
// the floor down to the frame's bottom edge.
//
// THE CONTRACT. A frame whose document draws the pdf floor is exactly as tall as
// that document reports; every other frame keeps the floor height beneath a
// shorter report, as before.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { LifecycleCardState, LifecycleTargetHeader } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: "ref-island-pdf-floor" };
const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const HEIGHT_MESSAGE_TYPE = "cinatra.review-island.height";
const ISLAND_MIN_HEIGHT = 380;

/** The height the floor document reports: the floor block, well under the frame's floor height. */
const FLOOR_REPORT = 118;

const HEADER: LifecycleTargetHeader = {
  title: "Media fixture: pdf",
  typeLabel: "Slide Deck",
  objectType: "@cinatra-ai/slide-deck-artifact:deck",
  revisionId: "rev-0000000000000001",
  facts: ["Personal", "Private"],
};

function mockResolve(): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state: PENDING,
          body: null,
          targetHeaders: [HEADER],
          targetHeadersComplete: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
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

function frameIn(container: HTMLElement): HTMLIFrameElement {
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("no island frame");
  return frame;
}

/** The frame's own document draws what the island would draw for this target. */
function islandDraws(frame: HTMLIFrameElement, markup: string): void {
  const doc = frame.contentDocument;
  if (!doc) throw new Error("no frame document");
  // jsdom leaves an unloaded frame's document without a body: give it a root.
  const root = doc.body ?? doc.documentElement ?? doc.appendChild(doc.createElement("html"));
  root.innerHTML = markup;
}

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

const PDF_FLOOR =
  '<article data-artifact-renderer="pdf-shell" data-slot="detail" data-floor="sandboxed-frame">' +
  "<p>This PDF cannot be previewed here.</p><a href=\"/d\" download>Download PDF</a></article>";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the island frame in the pdf floor state", () => {
  // red-first-expect: expected '380px' to be '118px'
  it("is exactly as tall as the floor document reports, with no blank area beneath it", async () => {
    mockResolve();
    const { container } = mountCard();
    await settle();
    const frame = frameIn(container);
    islandDraws(frame, PDF_FLOOR);
    await islandReports(frame, FLOOR_REPORT);
    expect(frame.style.height).toBe(`${FLOOR_REPORT}px`);
  });

  it("keeps the floor height beneath a shorter report from any other document", async () => {
    mockResolve();
    const { container } = mountCard();
    await settle();
    const frame = frameIn(container);
    islandDraws(frame, '<article data-artifact-renderer="pdf-shell" data-slot="detail"><embed type="application/pdf"></article>');
    await islandReports(frame, FLOOR_REPORT);
    expect(frame.style.height).toBe(`${ISLAND_MIN_HEIGHT}px`);
  });

  it("follows a taller report exactly in either state", async () => {
    mockResolve();
    const { container } = mountCard();
    await settle();
    const frame = frameIn(container);
    islandDraws(frame, PDF_FLOOR);
    await islandReports(frame, 512);
    expect(frame.style.height).toBe("512px");
  });
});
