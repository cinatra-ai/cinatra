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
import { cleanup, render } from "@testing-library/react";

import {
  REVIEW_ISLAND_PROGRESS_CHANNEL,
  parseReviewIslandFrameName,
  reviewIslandFrameName,
} from "../island-progress";
import {
  IslandPanelMountedSignal,
  IslandReadySignal,
} from "../island-progress-signals";

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
