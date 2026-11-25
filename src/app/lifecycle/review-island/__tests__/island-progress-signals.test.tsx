// @vitest-environment jsdom
//
// cinatra#3334 — THE ISLAND'S HALF OF THE CARD'S LOAD PROTOCOL.
//
// The card watches two bounds and cannot see inside this document, so the
// document says two things and nothing else: `island-ready`, before any panel
// work, and `panel-mounted`, as each panel mounts. Both are DATA-FREE — the
// channel, the event, and the attempt the card stamped on this frame's name.
// No ref, no target id, no credential, ever: that is what makes it safe to
// answer an opener whose origin this document is not told.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";

import {
  REVIEW_ISLAND_PROGRESS_CHANNEL,
  parseReviewIslandFrameName,
  reviewIslandFrameName,
} from "../island-height-report";
import {
  IslandPanelMountedSignal,
  IslandReadySignal,
} from "../island-height-reporter";

const ORIGINAL_NAME = window.name;
let posted: Array<[unknown, string]>;

beforeEach(() => {
  posted = [];
  vi.spyOn(window.parent, "postMessage").mockImplementation(
    ((message: unknown, targetOrigin: string) => {
      posted.push([message, targetOrigin]);
    }) as typeof window.parent.postMessage,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.name = ORIGINAL_NAME;
});

describe("the frame name is the card's attempt stamp", () => {
  it("round-trips the attempt the card stamped", () => {
    expect(parseReviewIslandFrameName(reviewIslandFrameName(0))).toBe(0);
    expect(parseReviewIslandFrameName(reviewIslandFrameName(7))).toBe(7);
  });

  it("refuses a name this card did not write", () => {
    for (const junk of ["", "cinatra-review-island", "other:1", "cinatra-review-island:x", null]) {
      expect(parseReviewIslandFrameName(junk)).toBeNull();
    }
  });
});

describe("the island reports its own progress, data-free", () => {
  it("posts island-ready once, naming the attempt and nothing else", () => {
    window.name = reviewIslandFrameName(3);
    render(<IslandReadySignal />);
    expect(posted).toHaveLength(1);
    const [message, targetOrigin] = posted[0];
    expect(message).toEqual({
      channel: REVIEW_ISLAND_PROGRESS_CHANNEL,
      type: "island-ready",
      attempt: 3,
    });
    // Data-free is what lets the document answer an opener it cannot name.
    expect(Object.keys(message as object).sort()).toEqual(["attempt", "channel", "type"]);
    expect(targetOrigin).toBe("*");
  });

  it("posts panel-mounted as a panel mounts", () => {
    window.name = reviewIslandFrameName(0);
    render(<IslandPanelMountedSignal />);
    expect(posted).toEqual([
      [
        { channel: REVIEW_ISLAND_PROGRESS_CHANNEL, type: "panel-mounted", attempt: 0 },
        "*",
      ],
    ]);
  });

  it("says nothing at all when the document is not inside the card's frame", () => {
    window.name = "";
    render(<IslandReadySignal />);
    render(<IslandPanelMountedSignal />);
    expect(posted).toEqual([]);
  });
});

// cinatra#3089 — THE DRAWN REPORT. A host whose decision waits on the items (the publish card's Allow) needs a positive
// word that they are on screen; a frame's `load` fires for an error page too. Once every panel the document was given
// has mounted it posts `island-drawn` with that count, once; the one empty document posts it with 0. Each test loads
// the module afresh: the count is the document's own state.
/** Past the island's settle bound (ISLAND_DRAWN_SETTLE_MS, 250 ms): a reading that held this long is reported. */
const held = async () => {
  // In steps, so React commits what each step scheduled (one act would hold every render back to its end).
  for (let step = 0; step < 15; step += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
};

describe("the island reports its items drawn", () => {
  const drawnPosts = () =>
    posted.filter(([message]) => (message as { type?: string }).type === "island-drawn");

  it("posts island-drawn once, with the count, after every panel it was given has mounted and held", async () => {
    vi.resetModules();
    const { IslandReadySignal: Ready, IslandPanelMountedSignal: Panel } = await import("../island-height-reporter");
    window.name = reviewIslandFrameName(2);
    render(<Ready panels={2} />);
    render(<Panel />);
    await held();
    expect(drawnPosts()).toEqual([]);
    render(<Panel />);
    expect(drawnPosts()).toEqual([]);
    await held();
    expect(drawnPosts()).toEqual([
      [{ channel: REVIEW_ISLAND_PROGRESS_CHANNEL, type: "island-drawn", attempt: 2, count: 2 }, "*"],
    ]);
    render(<Panel />);
    await held();
    expect(drawnPosts()).toHaveLength(1);
  });

  it("the empty document posts island-drawn with 0 and no island-ready", async () => {
    vi.resetModules();
    const { IslandReadySignal: Ready } = await import("../island-height-reporter");
    window.name = reviewIslandFrameName(0);
    render(<Ready panels={0} />);
    expect(posted).toEqual([
      [{ channel: REVIEW_ISLAND_PROGRESS_CHANNEL, type: "island-drawn", attempt: 0, count: 0 }, "*"],
    ]);
  });
});

// cinatra#3089: a panel is drawn only once every item in it has finished loading. The panels below are the island's
// real item drawings (the pinned before/after capture and the image representation's inline preview), wrapped by the
// signal as the island page wraps each target's panel. Each image's decode promise is held by the test: a deferred
// image keeps the drawn report back, a failed one posts `island-failed` and no drawn report ever follows.
describe("the island reports drawn only once each item's own content loaded", () => {
  type Decode = { resolve: () => void; reject: () => void };
  let decodes: Map<string, Decode>;
  beforeEach(() => {
    decodes = new Map();
    // jsdom loads no images: each image's decode promise is the test's to settle.
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: function (this: HTMLImageElement) {
        return new Promise<void>((resolve, reject) => {
          decodes.set(this.getAttribute("src") ?? "", { resolve, reject: () => reject(new Error("EncodingError")) });
        });
      },
    });
  });
  afterEach(() => {
    delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
  });
  const types = () => posted.map(([message]) => (message as { type?: string }).type);
  const capture = (imageUrl: string) => ({
    captureArtifactId: `cap-${imageUrl}`, role: "before" as const, status: "ready" as const, imageUrl,
    degradedReason: null, capturedAt: "2026-11-25", sourceOrigin: null, regions: [], captureDigest: null,
    removedConstructs: 0, blockedSubresources: 0, composition: null,
  });
  const pair = (left: string, right: string) => ({
    kind: "review" as const, left: capture(left), right: { ...capture(right), role: "current" as const },
    leftLabel: "Now", rightLabel: "After",
  });
  const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

  it("a deferred capture image holds the drawn report back until it loads", async () => {
    vi.resetModules();
    const { IslandReadySignal: Ready, IslandPanelMountedSignal: Panel } = await import("../island-height-reporter");
    const { ReviewPinnedCapture } = await import("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-pinned-capture");
    const { ArtifactInlinePreview } = await import("@/components/artifacts/artifact-inline-preview");
    window.name = reviewIslandFrameName(4);
    render(
      <>
        <Ready panels={2} />
        <Panel><p>The email body text</p><ReviewPinnedCapture pair={pair("/before.png", "/after.png") as never} /></Panel>
        <Panel><ArtifactInlinePreview previewHref="/image.png" mime="image/png" /></Panel>
      </>,
    );
    await settle();
    // Mounted, but its images are still on their way.
    expect(types()).toEqual(["island-ready", "panel-mounted", "panel-mounted"]);
    decodes.get("/before.png")!.resolve();
    decodes.get("/image.png")!.resolve();
    await held();
    expect(types()).not.toContain("island-drawn");
    decodes.get("/after.png")!.resolve();
    await settle();
    expect(types()).not.toContain("island-drawn");
    await held();
    expect(types()).toEqual(["island-ready", "panel-mounted", "panel-mounted", "island-drawn"]);
  });

  it("a failed image posts island-failed, and no drawn report follows on this document", async () => {
    vi.resetModules();
    const { IslandReadySignal: Ready, IslandPanelMountedSignal: Panel } = await import("../island-height-reporter");
    const { ArtifactInlinePreview } = await import("@/components/artifacts/artifact-inline-preview");
    window.name = reviewIslandFrameName(5);
    render(
      <>
        <Ready panels={2} />
        <Panel><ArtifactInlinePreview previewHref="/broken.png" mime="image/png" /></Panel>
        <Panel><ArtifactInlinePreview previewHref="/fine.png" mime="image/png" /></Panel>
      </>,
    );
    await settle();
    decodes.get("/fine.png")!.resolve();
    decodes.get("/broken.png")!.reject();
    await settle();
    expect(types()).toEqual(["island-ready", "panel-mounted", "panel-mounted", "island-failed"]);
    expect(posted.find(([m]) => (m as { type?: string }).type === "island-failed")![0]).toEqual({
      channel: REVIEW_ISLAND_PROGRESS_CHANNEL, type: "island-failed", attempt: 5,
    });
  });

  it("a display still loading holds the report back, and a display that fell to its floor is a failure", async () => {
    vi.resetModules();
    const { IslandReadySignal: Ready, IslandPanelMountedSignal: Panel } = await import("../island-height-reporter");
    window.name = reviewIslandFrameName(6);
    const { rerender } = render(
      <>
        <Ready panels={1} />
        <Panel><div data-dynamic-renderer-skeleton="" aria-busy="true" /></Panel>
      </>,
    );
    await held();
    expect(types()).toEqual(["island-ready", "panel-mounted"]);
    rerender(
      <>
        <Ready panels={1} />
        <Panel><div data-dynamic-renderer-floor="timeout"><p>review target unavailable</p></div></Panel>
      </>,
    );
    await settle();
    expect(types()).toEqual(["island-ready", "panel-mounted", "island-failed"]);
  });
});

// cinatra#3089: THE DISPLAY CONTRACT, through the real island panel. A display that is not finished drawing marks
// itself `aria-busy="true"` or renders a `role="status"` loader; the host honours both, keeps watching after its drawn
// report, and reports drawn only once a reading has held for the settle bound.
describe("the island honours a display's busy marks and never stops watching", () => {
  const types = () => posted.map(([message]) => (message as { type?: string }).type);
  const tick = async (ms = 0) => {
    for (let waited = 0; waited <= ms; waited += 10) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, ms)));
      });
    }
  };
  let setBusy: (busy: boolean) => void = () => {};
  /** A client display: an unmarked placeholder on its first commit, busy from the next tick, drawn when told. */
  function AsyncDisplay({ marker }: { marker: "aria-busy" | "role-status" }) {
    const [busy, setState] = useState<boolean | null>(null);
    setBusy = setState;
    useEffect(() => {
      const timer = setTimeout(() => setState((current) => (current === null ? true : current)), 0);
      return () => clearTimeout(timer);
    }, []);
    if (busy === null) return <div data-placeholder="" />;
    if (marker === "role-status") return busy ? <div role="status" aria-label="Loading" /> : <p>The chart</p>;
    return <div aria-busy={busy ? "true" : undefined}>{busy ? null : <p>The chart</p>}</div>;
  }
  const mount = async (attempt: number, marker: "aria-busy" | "role-status") => {
    vi.resetModules();
    const { IslandReadySignal: Ready, IslandPanelMountedSignal: Panel } = await import("../island-height-reporter");
    window.name = reviewIslandFrameName(attempt);
    render(
      <>
        <Ready panels={1} />
        <Panel><AsyncDisplay marker={marker} /></Panel>
      </>,
    );
  };

  it("an unmarked first commit that marks busy on the next tick reports nothing until busy clears and holds", async () => {
    await mount(7, "aria-busy");
    await held();
    expect(types()).toEqual(["island-ready", "panel-mounted"]);
    await act(async () => setBusy(false));
    await held();
    expect(types()).toEqual(["island-ready", "panel-mounted", "island-drawn"]);
  });

  it("a role=status loader holds the drawn report back the same way", async () => {
    await mount(8, "role-status");
    await held();
    expect(types()).toEqual(["island-ready", "panel-mounted"]);
    await act(async () => setBusy(false));
    await held();
    expect(types()).toEqual(["island-ready", "panel-mounted", "island-drawn"]);
  });

  it("a display that is busy again after the drawn report posts island-busy at once, then drawn again once it held", async () => {
    await mount(9, "aria-busy");
    await tick(10);
    await act(async () => setBusy(false));
    await held();
    expect(types()).toEqual(["island-ready", "panel-mounted", "island-drawn"]);
    await act(async () => setBusy(true));
    await tick();
    expect(types()).toEqual(["island-ready", "panel-mounted", "island-drawn", "island-busy"]);
    expect(posted.at(-1)![0]).toEqual({ channel: REVIEW_ISLAND_PROGRESS_CHANNEL, type: "island-busy", attempt: 9 });
    await act(async () => setBusy(false));
    await held();
    expect(types()).toEqual(["island-ready", "panel-mounted", "island-drawn", "island-busy", "island-drawn"]);
  });

  it("a display that toggles faster than the settle bound is never reported drawn in between", async () => {
    await mount(10, "aria-busy");
    await tick(10);
    for (let i = 0; i < 4; i += 1) {
      await act(async () => setBusy(false));
      await tick(100);
      await act(async () => setBusy(true));
      await tick(20);
    }
    expect(types()).toEqual(["island-ready", "panel-mounted"]);
    await act(async () => setBusy(false));
    await tick(150);
    // Under the bound since the last change: still nothing.
    expect(types()).not.toContain("island-drawn");
    await tick(150);
    expect(types()).toEqual(["island-ready", "panel-mounted", "island-drawn"]);
  });
});
