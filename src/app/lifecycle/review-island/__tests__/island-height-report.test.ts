// @vitest-environment jsdom
//
// THE ISLAND MEASURES ITS OWN CONTENT (the twelfth proof round's counted defect
// on cinatra#3143, 2026-09-10). The host can only size the frame from a height
// the island document reports, and the number it reports has to be the height
// of the WORK — not the height of the box the host is currently giving it.
//
// That distinction is the whole mechanism. The island body carries `min-h-dvh`
// so the document's own ground never paints around the panel, which pins
// `scrollHeight` to at least the frame's own height: a reporter that read it
// would answer the host with the host's own number and the frame could never
// come back down off a constant. So the measurement walks the CONTENT — the
// island body's children — and adds the padding beneath them.
//
// It reads no palette, which is the third of the round's readings stated at the
// module tier: the same content answers the same number in light and in dark,
// so the same rows sit at the same offset in both.

import { describe, expect, it } from "vitest";

import {
  islandContentHeight,
  parseReviewIslandHeight,
  reviewIslandHeightMessage,
  REVIEW_ISLAND_HEIGHT_MESSAGE_TYPE,
} from "../island-height-report";

/** A stand-in for the island body: children at known offsets, and a container
 *  whose own box is deliberately TALLER than them (what `min-h-dvh` does). */
function islandBody(options: {
  scheme: "light" | "dark";
  panels: number[];
  containerHeight: number;
}): { container: HTMLElement; marker: HTMLElement } {
  const container = document.createElement("div");
  container.className =
    options.scheme === "dark"
      ? "dark min-h-dvh text-foreground flex flex-col gap-3 bg-surface p-3"
      : "cinatra min-h-dvh text-foreground flex flex-col gap-3 bg-surface p-3";
  const PAD = 12;
  const GAP = 12;
  document.body.appendChild(container);

  // jsdom lays nothing out, so every box below is stated rather than measured —
  // the arithmetic under test is the walk, not the browser's layout.
  container.getBoundingClientRect = () =>
    ({ top: 0, bottom: options.containerHeight, height: options.containerHeight, width: 900, left: 0, right: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  container.style.paddingTop = `${PAD}px`;
  container.style.paddingBottom = `${PAD}px`;

  let top = PAD;
  for (const height of options.panels) {
    const panel = document.createElement("div");
    const bottom = top + height;
    panel.getBoundingClientRect = () =>
      ({ top, bottom, height, width: 876, left: 12, right: 888, x: 12, y: top, toJSON: () => ({}) }) as DOMRect;
    container.appendChild(panel);
    top = bottom + GAP;
  }

  // The reporter's own marker — hidden, and never part of the measurement.
  const marker = document.createElement("span");
  marker.hidden = true;
  marker.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  container.appendChild(marker);
  return { container, marker };
}

describe("the island measures the height of its work, not of the box it was given", () => {
  it("answers the content height even when the frame is far taller", () => {
    const { container, marker } = islandBody({
      scheme: "light",
      panels: [300, 300, 300, 300, 300, 236],
      containerHeight: 2280, // the constant the host is still holding
    });
    // 12 top pad + six panels + five 12px gaps + 12 bottom pad
    expect(islandContentHeight(container, marker)).toBe(1820);
  });

  it("answers the content height when the frame is far shorter — the clip", () => {
    const { container, marker } = islandBody({
      scheme: "light",
      panels: [500, 500, 500, 500, 500, 500],
      containerHeight: 2280,
    });
    expect(islandContentHeight(container, marker)).toBe(3084);
    expect(islandContentHeight(container, marker)).toBeGreaterThan(2280);
  });

  it("reads no palette — dark answers exactly what light answers", () => {
    const panels = [300, 300, 300, 300, 300, 236];
    const light = islandBody({ scheme: "light", panels, containerHeight: 2280 });
    const dark = islandBody({ scheme: "dark", panels, containerHeight: 2280 });
    expect(islandContentHeight(dark.container, dark.marker)).toBe(
      islandContentHeight(light.container, light.marker),
    );
  });

  it("leaves an unlaid-out child (the ground stylesheet) out of the walk", () => {
    const { container, marker } = islandBody({
      scheme: "dark",
      panels: [400],
      containerHeight: 2280,
    });
    const style = document.createElement("style");
    style.getBoundingClientRect = () =>
      ({ top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    container.insertBefore(style, container.firstChild);
    expect(islandContentHeight(container, marker)).toBe(424);
  });
});

describe("the height message is one number and nothing else", () => {
  it("round-trips a measured height", () => {
    expect(parseReviewIslandHeight(reviewIslandHeightMessage(1772.4))).toBe(1773);
  });

  it("refuses anything that is not this message", () => {
    for (const raw of [
      null,
      undefined,
      "1772",
      { type: "cinatra.something-else", height: 1772 },
      { type: REVIEW_ISLAND_HEIGHT_MESSAGE_TYPE },
      { type: REVIEW_ISLAND_HEIGHT_MESSAGE_TYPE, height: "1772" },
      { type: REVIEW_ISLAND_HEIGHT_MESSAGE_TYPE, height: Number.NaN },
      { type: REVIEW_ISLAND_HEIGHT_MESSAGE_TYPE, height: 0 },
      { type: REVIEW_ISLAND_HEIGHT_MESSAGE_TYPE, height: -12 },
    ]) {
      expect(parseReviewIslandHeight(raw)).toBeNull();
    }
  });
});
