/**
 * The review card's island paint wait (tests/e2e/wp-drupal-uat/island-paint.ts),
 * driven by readings of a card whose islands change between them.
 *
 * The defect these cases stand for: the wait was split into "an island is
 * attached" and then "no island reads anything but loaded". When the one island
 * detached between the two reads, the second read found an empty card, which
 * holds no island that is not loaded, so the wait passed and a screenshot could
 * be taken with nothing painted. Each reading here is the predicate itself,
 * evaluated over the card as it stands at that reading.
 */
import { describe, expect, it } from "vitest";

import {
  ISLAND_PAINT_MESSAGE,
  REVIEW_TARGET_ISLAND,
  allIslandsLoaded,
  pollIslandPaint,
} from "../wp-drupal-uat/island-paint";

/** A card whose islands read `states`, in page order; `null` is an island
 *  without the attribute. */
function card(states: ReadonlyArray<string | null>): ParentNode {
  const islands = states.map((state) => ({
    getAttribute: (name: string) => (name === "data-island-load-state" ? state : null),
  }));
  return {
    querySelectorAll: (selector: string) => {
      expect(selector).toBe(REVIEW_TARGET_ISLAND);
      return islands;
    },
  } as unknown as ParentNode;
}

/** A reader over a card that reads `cards[i]` at its i-th reading and the last
 *  one from then on; a card that is an Error is a reading that throws. */
function scripted(cards: ReadonlyArray<ReadonlyArray<string | null> | Error>) {
  let reads = 0;
  const read = async (selector: string) => {
    const now = cards[Math.min(reads, cards.length - 1)];
    reads += 1;
    if (now instanceof Error) throw now;
    return allIslandsLoaded(card(now), selector);
  };
  return { read, reads: () => reads };
}

const BOUND = 300;
const POLL = 10;

describe("allIslandsLoaded", () => {
  it("is false on a card with no island", () => {
    expect(allIslandsLoaded(card([]), REVIEW_TARGET_ISLAND)).toBe(false);
  });

  it("is true only when every island reads loaded", () => {
    expect(allIslandsLoaded(card(["loaded"]), REVIEW_TARGET_ISLAND)).toBe(true);
    expect(allIslandsLoaded(card(["loaded", "loaded"]), REVIEW_TARGET_ISLAND)).toBe(true);
    expect(allIslandsLoaded(card(["loaded", "loading"]), REVIEW_TARGET_ISLAND)).toBe(false);
    expect(allIslandsLoaded(card(["timed-out", "loaded"]), REVIEW_TARGET_ISLAND)).toBe(false);
    expect(allIslandsLoaded(card(["loaded", null]), REVIEW_TARGET_ISLAND)).toBe(false);
  });
});

describe("pollIslandPaint", () => {
  it("does not pass when the attached island detaches before it loads", async () => {
    const reader = scripted([["loading"], []]);
    await expect(pollIslandPaint(reader.read, BOUND, POLL)).rejects.toThrow(ISLAND_PAINT_MESSAGE);
    expect(reader.reads(), "the wait kept reading the empty card until its bound").toBeGreaterThan(2);
  });

  it("does not pass on a card that never draws an island", async () => {
    const reader = scripted([[]]);
    await expect(pollIslandPaint(reader.read, BOUND, POLL)).rejects.toThrow(ISLAND_PAINT_MESSAGE);
  });

  it("does not pass on a card whose later island never loads", async () => {
    const reader = scripted([["loaded", "loading"]]);
    await expect(pollIslandPaint(reader.read, BOUND, POLL)).rejects.toThrow(ISLAND_PAINT_MESSAGE);
  });

  it("passes at the first reading where every island has loaded", async () => {
    const reader = scripted([["loading", "loading"], ["loaded", "loading"], ["loaded", "loaded"]]);
    await pollIslandPaint(reader.read, BOUND, POLL);
    expect(reader.reads()).toBe(3);
  });

  it("waits through a detached island for the one drawn in its place", async () => {
    const reader = scripted([["loading"], [], ["loaded"]]);
    await pollIslandPaint(reader.read, BOUND, POLL);
    expect(reader.reads()).toBe(3);
  });

  it("counts a reading that throws as not painted", async () => {
    const reader = scripted([new Error("Frame was detached"), [], ["loaded"]]);
    await pollIslandPaint(reader.read, BOUND, POLL);
    expect(reader.reads()).toBe(3);
    const broken = scripted([new Error("Execution context was destroyed\nmore")]);
    await expect(pollIslandPaint(broken.read, BOUND, POLL)).rejects.toThrow(
      /\(last reading: unreadable: Execution context was destroyed\)$/,
    );
  });
});
