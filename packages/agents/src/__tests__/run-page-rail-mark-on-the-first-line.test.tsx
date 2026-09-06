// @vitest-environment jsdom
/**
 * THE MARK READS AGAINST THE FIRST TEXT LINE, ON A WRAPPED ROW TOO
 * (cinatra#3225 item 3, fix leg 8).
 *
 * The ratified drawing, agent run and review surface, fixes the rail's two
 * boxes in one rule —
 *
 *   ".rail .step { display: flex; align-items: center; gap: 8px; padding: 2px 0;
 *      ... line-height: 1.15; }"
 *   ".rail .sep  { width: 2px; height: 8px; margin: 4px 0 4px 11px;
 *      border-radius: 1px; background: var(--line); }"
 *
 * — over rows whose label is ONE line. A rail label wraps inside the 208px
 * column (cinatra#3226), and the shared `Button` centred its children over the
 * whole box: on a wrapped row the circle drifted DOWN the block, off the line it
 * names, and the marks either side of it stopped reading against that line. The
 * fourth proof round measured it on a real run: 6px above the mark and 15px
 * below it, then 15 and 6, where every pair of one rail reads one gap.
 *
 * WHAT IS PINNED HERE. The row aligns to its FIRST TEXT LINE, the label's own
 * line box is centred in the circle beside it, and the gap between a circle and
 * the mark beneath it does NOT move when the row above wraps — the reading the
 * round measured at 6 and then 15.
 *
 * THE INSTRUMENT. jsdom lays nothing out, so every box is RESOLVED from the
 * utility tokens the rendered rows and marks carry — the same tokens a picture
 * is graded on, read off the REAL rendered rail rather than typed into the
 * harness — with the wrap itself the one thing the harness states, because a
 * jsdom label never wraps.
 *
 * BOTH PALETTES: the reading is taken with the document in each, so an
 * alignment that held in only one (a `dark:`-scoped token) cannot pass.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-page-rail-mark-on-the-first-line.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { RunStepRailPanel } from "../run-step-rail-panel";
import type { RunStepRailEntry } from "../run-step-rail";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

const SPACING: Record<string, number> = {
  "0": 0,
  "0.5": 2,
  "1": 4,
  "1.5": 6,
  "2": 8,
  "3": 12,
  "4": 16,
  "5": 20,
  "6": 24,
};
const CIRCLE_PX = 24; // `size-6`, the circle every row carries

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

/** The value of the LAST matching token, an `!`-important one winning outright. */
function resolve(
  className: string,
  pattern: RegExp,
  read: (m: RegExpMatchArray) => number,
): number | null {
  let value: number | null = null;
  let important = false;
  for (const raw of tokens(className)) {
    const bang = raw.startsWith("!");
    const token = bang ? raw.slice(1) : raw;
    const bare = token.includes(":") ? token.slice(token.lastIndexOf(":") + 1) : token;
    const m = bare.match(pattern);
    if (!m) continue;
    if (important && !bang) continue;
    value = read(m);
    important = important || bang;
  }
  return value;
}

const px = (m: RegExpMatchArray) =>
  m[1]!.startsWith("[") ? Number(m[1]!.slice(1, -3)) : SPACING[m[1]!]!;

/** The alignment the row resolves to — the LAST alignment token wins. */
function alignment(className: string): "start" | "center" | null {
  let value: "start" | "center" | null = null;
  for (const raw of tokens(className)) {
    const bare = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
    if (bare === "items-start") value = "start";
    if (bare === "items-center") value = "center";
  }
  return value;
}

/** The row element a rail row's classes are read from. */
function rowElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-rail-kind]"));
}

function markElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="stepper-separator"]'),
  );
}

/** The label box a row's own title tokens compose, for `lines` lines of it. */
function titleBox(row: HTMLElement, lines: number) {
  const title = row.querySelector<HTMLElement>('[data-slot="stepper-title"]');
  expect(title, "every rail row carries a title").not.toBeNull();
  const c = title!.className;
  const lineHeight = resolve(c, /^leading-(\d+(?:\.\d+)?|\[\d+px\])$/, px);
  const marginTop = resolve(c, /^mt-(\d+(?:\.\d+)?)$/, px) ?? 0;
  expect(lineHeight, "the label states its own line box").not.toBeNull();
  return { lineHeight: lineHeight!, marginTop, height: marginTop + lines * lineHeight! };
}

/** A ROW's box, for a label of `lines` lines. */
function rowBox(row: HTMLElement, lines: number) {
  // The alignment and the padding are the trigger's (the row's own box); the
  // wrapper beside it states the same alignment.
  const trigger =
    row.querySelector<HTMLElement>("button, a") ?? (row as HTMLElement);
  const c = `${row.className} ${trigger.className}`;
  const py = resolve(trigger.className, /^py-(\d+(?:\.\d+)?)$/, px) ?? 0;
  const title = titleBox(row, lines);
  const content = Math.max(CIRCLE_PX, title.height);
  const height = content + 2 * py;
  const align = alignment(c);
  const circleCentre =
    align === "start" ? py + CIRCLE_PX / 2 : py + content / 2;
  return { height, circleCentre, align, py, title };
}

function markBox(mark: HTMLElement) {
  const c = mark.className;
  const height = resolve(c, /^h-(\d+(?:\.\d+)?|\[\d+px\])$/, px) ?? 0;
  const my = resolve(c, /^my-(\d+(?:\.\d+)?)$/, px);
  const m = resolve(c, /^m-(\d+(?:\.\d+)?)$/, px) ?? 0;
  return { height, marginTop: my ?? m, marginBottom: my ?? m };
}

/** One work step whose name is what it did — the label that wraps. */
function entries(): RunStepRailEntry[] {
  return [
    {
      key: "step:1",
      ordinal: 1,
      kind: "step",
      label: "Fetched the Q3 cohort",
      status: "completed",
      sources: [],
    },
    {
      key: "step:2",
      ordinal: 2,
      kind: "step",
      label: "Why Release Notes Belong in the Sprint, Not After It",
      status: "completed",
      sources: [],
    },
    {
      key: "step:3",
      ordinal: 3,
      kind: "step",
      label: "Review",
      status: "pending",
      sources: [],
    },
  ];
}

function renderRail() {
  return render(
    <RunStepRailPanel entries={entries()} activeOrdinal={3} reviewHrefBase="/r" />,
  );
}

const PALETTES = ["light", "dark"] as const;

describe.each(PALETTES)("the rail's rows, in the %s palette", (palette) => {
  const inPalette = () => {
    document.documentElement.classList.toggle("dark", palette === "dark");
    return renderRail();
  };

  it("aligns every row to its FIRST text line, not to the block centre", () => {
    const { container } = inPalette();
    const rows = rowElements(container);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(rowBox(row, 1).align).toBe("start");
    }
  });

  it("centres the label's first line box in the circle beside it", () => {
    const { container } = inPalette();
    for (const row of rowElements(container)) {
      const { title } = rowBox(row, 1);
      // The first line's own centre, measured from the row's content top, is
      // the circle's centre: a single-line row is drawn exactly where the
      // centred reading drew it.
      expect(title.marginTop + title.lineHeight / 2).toBe(CIRCLE_PX / 2);
    }
  });

  it("keeps the mark's own margins the drawing's 4 above and 4 below", () => {
    const { container } = inPalette();
    const marks = markElements(container);
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      const box = markBox(mark);
      expect(box.marginTop).toBe(4);
      expect(box.marginBottom).toBe(4);
      expect(box.height).toBe(8);
    }
  });

  it("reads the same gap from a circle to the mark beneath it however the row wraps", () => {
    const { container } = inPalette();
    const rows = rowElements(container);
    const marks = markElements(container);
    expect(marks.length).toBe(rows.length - 1);
    // The reading the fourth proof round measured at 6 and then 15: the gap
    // between the mark and the circle of the row BELOW it, where that row's
    // label takes one line, two lines and three.
    const gapsBelow = [1, 2, 3].map((lines) => {
      const below = rowBox(rows[1]!, lines);
      return markBox(marks[0]!).marginBottom + below.circleCentre - CIRCLE_PX / 2;
    });
    expect(new Set(gapsBelow).size).toBe(1);
    expect(gapsBelow[0]).toBe(6);
    // And the same gap above the mark, from the circle of the row above it.
    const gapsAbove = [1, 2, 3].map((lines) => {
      const above = rowBox(rows[0]!, lines);
      return above.py + CIRCLE_PX / 2 - CIRCLE_PX / 2 + markBox(marks[0]!).marginTop;
    });
    expect(new Set(gapsAbove).size).toBe(1);
    expect(gapsAbove[0]).toBe(6);
  });
});
