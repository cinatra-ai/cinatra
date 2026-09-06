// @vitest-environment jsdom
/**
 * ONE RHYTHM ON A WRAPPED ROW TOO (cinatra#3225 items 2 and 3, fix leg 9).
 *
 * The ratified drawing, agent run and review surface, §I, fixes the rail's two
 * boxes in one rule —
 *
 *   ".rail .step { display: flex; align-items: center; gap: 8px; padding: 2px 0;
 *      ... line-height: 1.15; }"
 *   ".rail .sep  { width: 2px; height: 8px; margin: 4px 0 4px 11px;
 *      border-radius: 1px; background: var(--line); }"
 *
 * — over rows whose label takes ONE line, where those numbers put 6px above the
 * mark and 6px below it and compose a 44px pitch between adjacent circle
 * centres. Read as a rule about the GAP rather than about the flow, that is the
 * mark standing exactly halfway between the two circles it stands between, and
 * it is the reading that survives a row whose label wraps.
 *
 * A rail label DOES wrap inside the 208px column (cinatra#3226) and the row
 * aligns to its first text line (fix leg 8), so the wrapped lines hang below the
 * circle they belong to. Drawn in flow, the mark inherited that overhang: the
 * fifth proof round measured, on a real completed run and in both palettes,
 * circle centres 241.75 / 285.75 / 367.75 — pitches 44.0 then 82.0 — with
 * separator gaps 7.0/7.0 on the one-line pair and 45.0/7.0 on the wrapped one.
 * One rail read at two rhythms, and the row's extra height reading as a doubled
 * margin instead of as its own lines.
 *
 * WHAT IS PINNED HERE, over one line, two and three:
 *   1. the gap above the mark equals the gap below it — one rhythm at every
 *      pair, however the row above wraps;
 *   2. a one-line pair still composes the drawing's own numbers exactly — 6px,
 *      the 8px mark, 6px, a 44px pitch;
 *   3. the pitch is the row's own box plus the drawing's 16px mark slot and
 *      NOTHING else, so each further line adds exactly one line box: the extra
 *      height comes from the row's lines, never from a doubled margin;
 *   4. the circle stays centred on the label's FIRST line (leg 8's reading,
 *      which the fifth round measured at 0.25 CSS px and which is kept), and the
 *      mark stays on the circles' own vertical line.
 *
 * THE INSTRUMENT. jsdom lays nothing out, so every box is RESOLVED from the
 * utility tokens the rendered rows and marks carry — the same tokens a picture
 * is graded on, read off the REAL rendered rail rather than typed into the
 * harness — with the wrap itself the one thing the harness states, because a
 * jsdom label never wraps. The resolver reads the mark BOTH ways, in the flow
 * and out of it, so it measures whatever composition the rail happens to carry
 * rather than assuming the one this leg installed.
 *
 * BOTH PALETTES: the reading is taken with the document in each, and no box may
 * be stated by a palette-scoped token.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-page-rail-wrapped-row-rhythm.test.tsx
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
/** The drawing's whole gap between two entries: 4px, an 8px mark, 4px. */
const MARK_SLOT_PX = 16;

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

/** A token stripped of its `!` and of any variant prefix, and its sign. */
function bare(raw: string): { token: string; negative: boolean; important: boolean } {
  const important = raw.startsWith("!");
  let token = important ? raw.slice(1) : raw;
  const negative = token.startsWith("-");
  if (negative) token = token.slice(1);
  if (token.includes(":")) token = token.slice(token.lastIndexOf(":") + 1);
  return { token, negative, important };
}

const px = (m: RegExpMatchArray) =>
  m[1]!.startsWith("[") ? Number(m[1]!.slice(1, -3)) : SPACING[m[1]!]!;

/** The value of the LAST matching token, an `!`-important one winning outright. */
function resolve(className: string, pattern: RegExp): number | null {
  let value: number | null = null;
  let important = false;
  for (const raw of tokens(className)) {
    const { token, negative, important: bang } = bare(raw);
    const m = token.match(pattern);
    if (!m) continue;
    if (important && !bang) continue;
    value = (negative ? -1 : 1) * px(m);
    important = important || bang;
  }
  return value;
}

const lengthOf = (prop: string) => new RegExp(`^${prop}-(\\d+(?:\\.\\d+)?|\\[\\d+px\\])$`);

function has(className: string, token: string): boolean {
  return tokens(className).some((raw) => bare(raw).token === token);
}

/** Every geometry token this file reads must hold in BOTH palettes. */
function paletteScoped(className: string): string[] {
  return tokens(className).filter((raw) => /(^|:)dark:/.test(raw) && !/^dark:(bg|text|border)-/.test(raw));
}

// ---------------------------------------------------------------------------
// The boxes.
// ---------------------------------------------------------------------------
type RowBox = {
  height: number;
  circleCentre: number;
  lineHeight: number;
  titleMarginTop: number;
};

/** A ROW's box, for a label of `lines` lines. */
function rowBox(row: HTMLElement, lines: number): RowBox {
  const trigger = row.querySelector<HTMLElement>("button, a") ?? row;
  const title = row.querySelector<HTMLElement>('[data-slot="stepper-title"]');
  expect(title, "every rail row carries a title").not.toBeNull();
  const lineHeight = resolve(title!.className, lengthOf("leading"));
  expect(lineHeight, "the label states its own line box").not.toBeNull();
  const titleMarginTop = resolve(title!.className, lengthOf("mt")) ?? 0;
  const py = resolve(trigger.className, lengthOf("py")) ?? 0;
  const content = Math.max(CIRCLE_PX, titleMarginTop + lines * lineHeight!);
  // The row aligns to its FIRST text line (leg 8): the circle sits after the
  // row's own top padding, never centred over the wrapped block.
  const alignedToFirstLine = has(`${row.className} ${trigger.className}`, "items-start");
  expect(alignedToFirstLine, "the row aligns to its first text line").toBe(true);
  return {
    height: content + 2 * py,
    circleCentre: py + CIRCLE_PX / 2,
    lineHeight: lineHeight!,
    titleMarginTop,
  };
}

type MarkPlacement = { pairHeight: number; top: number; bottom: number; centre: number };

/**
 * WHERE THE MARK ACTUALLY LANDS inside the box it shares with the row above it,
 * read whichever way the rail composes it — in the flow, where the row's own
 * height pushes the mark down, or out of it, where the mark is centred in the
 * gap the pair box states.
 */
function markPlacement(mark: HTMLElement, row: RowBox): MarkPlacement {
  const c = mark.className;
  const pair = mark.parentElement;
  expect(pair, "the mark stands inside the box it shares with its row").not.toBeNull();
  const pb = resolve(pair!.className, lengthOf("pb")) ?? 0;
  const height = resolve(c, lengthOf("h")) ?? 0;
  const left = resolve(c, lengthOf("left")) ?? resolve(c, lengthOf("ml")) ?? 0;
  const width = resolve(c, lengthOf("w")) ?? 0;

  if (has(c, "absolute")) {
    const top = resolve(c, lengthOf("top")) ?? 0;
    const bottomOffset = resolve(c, lengthOf("bottom")) ?? 0;
    const pairHeight = row.height + pb;
    // `top`, `bottom` and a fixed height with auto block margins: the free
    // space is split equally above and below — the mark is centred in the box.
    const free = pairHeight - top - height - bottomOffset;
    const marginTop = has(c, "my-auto") ? free / 2 : (resolve(c, lengthOf("my")) ?? 0);
    return {
      pairHeight,
      top: top + marginTop,
      bottom: top + marginTop + height,
      centre: left + width / 2,
    };
  }

  const my = resolve(c, lengthOf("my")) ?? resolve(c, lengthOf("m")) ?? 0;
  return {
    pairHeight: row.height + my + height + my + pb,
    top: row.height + my,
    bottom: row.height + my + height,
    centre: left + width / 2,
  };
}

/** The pair the mark stands in: its two gaps, and its circle-to-circle pitch. */
function pair(rows: HTMLElement[], marks: HTMLElement[], index: number, lines: number) {
  const above = rowBox(rows[index]!, lines);
  const below = rowBox(rows[index + 1]!, 1);
  const mark = markPlacement(marks[index]!, above);
  const circleBottom = above.circleCentre + CIRCLE_PX / 2;
  const nextCircleTop = mark.pairHeight + below.circleCentre - CIRCLE_PX / 2;
  return {
    row: above,
    mark,
    gapAbove: mark.top - circleBottom,
    gapBelow: nextCircleTop - mark.bottom,
    pitch: mark.pairHeight - above.circleCentre + below.circleCentre,
  };
}

// ---------------------------------------------------------------------------
// The rail under the reading: a work step named by what it did, which is what
// wraps inside the 208px column.
// ---------------------------------------------------------------------------
function entries(): RunStepRailEntry[] {
  return [
    {
      key: "step:1",
      ordinal: 1,
      kind: "step",
      label: "Setup",
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
      status: "completed",
      sources: [],
    },
  ];
}

function railReading(palette: "light" | "dark") {
  document.documentElement.classList.toggle("dark", palette === "dark");
  const { container } = render(
    <RunStepRailPanel entries={entries()} activeOrdinal={null} reviewHrefBase="/r" />,
  );
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-rail-kind]"));
  const marks = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="stepper-separator"]'),
  );
  expect(rows.length).toBe(3);
  expect(marks.length).toBe(2);
  return { rows, marks };
}

const LINE_COUNTS = [1, 2, 3] as const;
const PALETTES = ["light", "dark"] as const;

describe.each(PALETTES)("the run page's rail, in the %s palette", (palette) => {
  it("stands the mark halfway between the two circles, however the row above wraps", () => {
    const { rows, marks } = railReading(palette);
    for (const lines of LINE_COUNTS) {
      const p = pair(rows, marks, 1, lines);
      expect(
        p.gapAbove,
        `a ${lines}-line row: ${p.gapAbove} above the mark, ${p.gapBelow} below it`,
      ).toBe(p.gapBelow);
    }
  });

  it("composes the drawing's own numbers unchanged on a one-line pair", () => {
    const { rows, marks } = railReading(palette);
    const p = pair(rows, marks, 0, 1);
    expect(p.gapAbove).toBe(6);
    expect(p.gapBelow).toBe(6);
    expect(p.mark.bottom - p.mark.top).toBe(8);
    expect(p.pitch).toBe(44);
  });

  it("takes the wrapped row's extra height from its LINES and nothing else", () => {
    const { rows, marks } = railReading(palette);
    const readings = LINE_COUNTS.map((lines) => pair(rows, marks, 1, lines));
    for (const p of readings) {
      // The pitch is the row's own box plus the drawing's 16px mark slot: no
      // margin of the row's is doubled into it.
      expect(p.pitch).toBe(p.row.height + MARK_SLOT_PX);
    }
    // And once the label is taller than the circle, each further line adds
    // exactly one line box to the rail and nothing more.
    const lineBox = readings[0]!.row.lineHeight;
    expect(readings[2]!.pitch - readings[1]!.pitch).toBe(lineBox);
  });

  it("keeps the circle on the label's first line and the mark on the circles' line", () => {
    const { rows, marks } = railReading(palette);
    const p = pair(rows, marks, 1, 3);
    // Leg 8's reading, kept: the label's first line box is centred in the circle.
    expect(p.row.titleMarginTop + p.row.lineHeight / 2).toBe(CIRCLE_PX / 2);
    // And the mark's own centre is the circle's centre, so the marks and the
    // circles read as one line down the rail.
    expect(p.mark.centre).toBe(CIRCLE_PX / 2);
  });

  it("states every one of those boxes without a palette-scoped token", () => {
    const { rows, marks } = railReading(palette);
    for (const element of [...rows, ...marks, ...marks.map((m) => m.parentElement!)]) {
      expect(paletteScoped(element.className)).toEqual([]);
    }
  });
});
