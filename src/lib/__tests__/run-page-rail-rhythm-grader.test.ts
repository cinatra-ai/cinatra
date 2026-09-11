/**
 * THE RAIL'S GRADER, REPLAYED OVER READINGS THE DRAWING'S OWN SENTENCES DESCRIBE
 * (cinatra#3225 items 2 and 3, fix leg 10).
 *
 * `tests/e2e/run-page-rail/rail-rhythm-grader.ts` is the instrument that reads
 * the run page's rail off a REAL layout, because jsdom lays out no text and so
 * can never produce the wrapped row two withdrawn legs of this branch got wrong.
 * An instrument that is only ever run against the build it was written for
 * proves nothing about itself, so this file replays it — it is a pure function
 * over a reading — against the composition the drawing states and against each
 * departure from it that this branch has actually shipped and withdrawn:
 *
 *   a 20px line box  (leg 8's `leading-5`, where the drawing states 1.15 over
 *                     its 14px, a 16.1px box: self-consistent in every other
 *                     number, so ONLY the line-box sentence catches it)
 *   a mark out of flow, and a mark nested inside a row's own box (leg 9)
 *   a gap that is not 4px, and a rail that composes two pitches
 *
 * The drawing's own numbers, for the rail this file grades — a one-line row, a
 * row whose label wraps to three lines, a one-line row:
 *
 *   line box   14 x 1.15 = 16.1
 *   row box    max(24, lines x 16.1) + 2 + 2  -> 28 one-line, 52.3 three-line
 *   mark       2 x 8, margin 4px 0 4px 11px, a sibling between two row boxes
 *   pitch      half of each row box plus 16   -> 44 and 44, or 56.15 and 56.15
 */
import { describe, expect, it } from "vitest";

import {
  CIRCLE_PX,
  LINE_BOX_PX,
  MARK_SPAN_PX,
  ROW_PADDING_PX,
  expectedPitch,
  expectedRowHeight,
  gradeRailReading,
  type RailReading,
  type RailRowReading,
  type RailSeparatorReading,
} from "../../../tests/e2e/run-page-rail/rail-rhythm-grader";

const COLUMN = { x: 0, y: 0, w: 208, h: 400 };

/** A row the drawing composes: its box, and its circle centred in that box. */
function row(label: string, top: number, lines: number, lineHeight = LINE_BOX_PX): RailRowReading {
  const h = expectedRowHeight(lines, lineHeight);
  return {
    label,
    box: { x: COLUMN.x, y: top, w: COLUMN.w, h },
    glyph: { x: COLUMN.x, y: top + h / 2 - CIRCLE_PX / 2, w: CIRCLE_PX, h: CIRCLE_PX },
    glyphRadius: "9999px",
    lines,
    lineHeight,
  };
}

/** The mark the drawing composes: a sibling, 4px under the row box above it. */
function mark(above: RailRowReading): RailSeparatorReading {
  return {
    box: { x: COLUMN.x + 11, y: above.box.y + above.box.h + 4, w: 2, h: 8 },
    marginTop: 4,
    marginBottom: 4,
    marginLeft: 11,
    radius: "1px",
    position: "static",
    siblingOfRows: true,
  };
}

/** The rail the drawing composes, from a list of line counts. */
function rail(palette: string, lineCounts: number[], lineHeight = LINE_BOX_PX): RailReading {
  const rows: RailRowReading[] = [];
  const separators: RailSeparatorReading[] = [];
  let top = 0;
  lineCounts.forEach((lines, index) => {
    const next = row(`row ${index + 1}`, top, lines, lineHeight);
    rows.push(next);
    top += next.box.h;
    if (index < lineCounts.length - 1) {
      separators.push(mark(next));
      top += MARK_SPAN_PX;
    }
  });
  return { palette, column: COLUMN, rows, separators };
}

const clone = (reading: RailReading): RailReading => structuredClone(reading);

describe("the drawing's own composition", () => {
  it("is graded silent — a one-line rail at the drawn 44px pitch", () => {
    const reading = rail("light", [1, 1, 1]);
    expect(reading.rows[0]!.box.h).toBe(CIRCLE_PX + 2 * ROW_PADDING_PX);
    expect(expectedPitch(reading.rows[0]!.box, reading.rows[1]!.box)).toBe(44);
    expect(gradeRailReading(reading)).toEqual([]);
  });

  it("is graded silent on a WRAPPED row, at the 52.3px box and the 56.15px pitch", () => {
    const reading = rail("dark", [1, 3, 1]);
    const wrapped = reading.rows[1]!;
    expect(wrapped.box.h).toBeCloseTo(3 * LINE_BOX_PX + 2 * ROW_PADDING_PX, 5);
    expect(wrapped.box.h).toBeCloseTo(52.3, 5);
    expect(expectedPitch(reading.rows[0]!.box, wrapped.box)).toBeCloseTo(56.15, 5);
    expect(gradeRailReading(reading)).toEqual([]);
  });
});

describe("each reading this branch has withdrawn", () => {
  it("names the 20px line box leg 8 chose, where every other number stays self-consistent (C1)", () => {
    // A rail laid out at `leading-5` composes a 64px three-line row and a 62px
    // pitch beside it, and every sentence about centring, margins and flow is
    // still satisfied: the line box itself is the only thing wrong, which is
    // why the grader has to state it.
    const reading = rail("light", [1, 3, 1], 20);
    expect(reading.rows[1]!.box.h).toBe(64);
    expect(expectedPitch(reading.rows[0]!.box, reading.rows[1]!.box)).toBe(62);
    const bad = gradeRailReading(reading);
    expect(bad.join("\n")).toContain("20 line box where the drawing's 14px over 1.15 is 16.1");
    expect(bad.every((line) => line.startsWith("light C1:"))).toBe(true);
  });

  it("names a mark taken out of the flow (C4)", () => {
    const reading = clone(rail("light", [1, 1]));
    reading.separators[0]!.position = "absolute";
    expect(gradeRailReading(reading).join("\n")).toContain("not a sibling in normal flow");
  });

  it("names a mark standing inside a row's own box (C4)", () => {
    const reading = clone(rail("dark", [1, 3, 1]));
    const wrapped = reading.rows[1]!;
    // The sixth proof round's reading: the mark inside the wrapped row's box.
    reading.separators[1]!.siblingOfRows = false;
    reading.separators[1]!.box.y = wrapped.box.y + wrapped.box.h / 2;
    const bad = gradeRailReading(reading).join("\n");
    expect(bad).toContain("nested inside a row box instead of standing between two");
    expect(bad).toContain("overlaps the row box");
  });

  it("names a gap that is not the drawn 4px, on the wrapped pair alone (C3, C4)", () => {
    const reading = clone(rail("light", [1, 3, 1]));
    reading.separators[1]!.marginTop = 25;
    reading.separators[1]!.marginBottom = 25;
    const bad = gradeRailReading(reading).join("\n");
    expect(bad).toContain("carries margins 25 above and 25 below, not 4 and 4");
    expect(bad).not.toContain("mark 1 carries margins");
  });

  it("names a rail that composes two pitches rather than one rhythm (C5)", () => {
    const reading = clone(rail("dark", [1, 1, 1]));
    // The third row pushed down: its own box is unchanged, so the pitch alone
    // departs — the reading a rail with two rhythms produces.
    reading.rows[2]!.box.y += 38;
    reading.rows[2]!.glyph.y += 38;
    const bad = gradeRailReading(reading).join("\n");
    expect(bad).toContain("composes a 82 pitch where half of 28 plus 16 plus half of 28 is 44");
  });

  it("names a circle that is not centred in its own row box (C1)", () => {
    const reading = clone(rail("light", [1, 3, 1]));
    // Leg 8's alignment: the circle on the label's FIRST line instead.
    reading.rows[1]!.glyph.y = reading.rows[1]!.box.y + ROW_PADDING_PX;
    expect(gradeRailReading(reading).join("\n")).toContain("in a row box centred at");
  });
});
