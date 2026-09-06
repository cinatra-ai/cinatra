/**
 * THE RAIL'S RHYTHM, GRADED FROM A REAL LAYOUT (cinatra#3225, fix leg 10).
 *
 * The ratified drawing, agent run and review surface, composes the rail from
 * three sentences and nothing else:
 *
 *   ".rail .step  { display: flex; align-items: center; gap: 8px; padding: 2px 0;
 *                   font-size: 14px; line-height: 1.15 }"
 *   ".rail .step .glyph { width: 24px; height: 24px; border-radius: 50% }"
 *   ".rail .sep   { width: 2px; height: 8px; margin: 4px 0 4px 11px;
 *                   border-radius: 1px }"
 *
 * Everything the rail's rhythm is follows from them: the circle is centred in
 * ITS OWN row box, and the row's leading is the drawing's own 1.15 over its
 * 14px — a 16.1px line box — so a three-line row (3 x 16.1 of text over the
 * row's own 2px either side, 52.3px) carries its circle at 26.2px down; the mark
 * is a SIBLING in normal flow with 4px against the row box above it and 4px
 * against the row box below it; and the pitch between two adjacent circles is
 * therefore half of each row box plus the mark's own 16px — 44 for a pair of
 * one-line rows, 56.2 where a one-line row meets a three-line one.
 *
 * WHY THIS FILE IS NOT A jsdom TEST. jsdom lays out no text, so it can never
 * produce a wrapped row: every jsdom reading of this rail is the tokens read
 * back, and two successive legs of cinatra#3236 passed such a reading while the
 * proof round measured something else on the page. The grader below takes a
 * reading of a REAL layout — boxes and computed margins off a live run page, in
 * one palette — and returns the sentences it violates. It is a pure function so
 * that the same grader can be replayed over a reading recorded earlier, which is
 * how leg 10 proved it red against the composition leg 9 shipped.
 */

export type Box = { x: number; y: number; w: number; h: number };

/** One `.rail .step` — the row box, and the circle the drawing centres in it. */
export type RailRowReading = {
  label: string;
  /** The row box itself: the flex row the drawing's `.rail .step` names. */
  box: Box;
  /** The 24px circle. */
  glyph: Box;
  /** The circle's computed `border-radius`. */
  glyphRadius: string;
  /** How many line boxes the row's own label takes. */
  lines: number;
  /** The label's computed line-height, in CSS px. */
  lineHeight: number;
};

/** One `.rail .sep` — the mark between two rows. */
export type RailSeparatorReading = {
  box: Box;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  radius: string;
  /** `static` is the drawing's composition: a sibling in normal flow. */
  position: string;
  /** Is this mark a normal-flow SIBLING of the row above it, never its child? */
  siblingOfRows: boolean;
};

export type RailReading = {
  palette: string;
  /** The rail column the rows and the marks are indented from. */
  column: Box;
  rows: RailRowReading[];
  separators: RailSeparatorReading[];
};

/** The drawing's own numbers, named once. */
export const CIRCLE_PX = 24;
/** ".rail .step { font-size: 14px; line-height: 1.15 }" — the label's line box. */
export const FONT_SIZE_PX = 14;
export const LINE_HEIGHT_RATIO = 1.15;
export const LINE_BOX_PX = FONT_SIZE_PX * LINE_HEIGHT_RATIO;
export const ROW_PADDING_PX = 2;
export const SEPARATOR_WIDTH_PX = 2;
export const SEPARATOR_HEIGHT_PX = 8;
export const SEPARATOR_GAP_PX = 4;
export const SEPARATOR_INDENT_PX = 11;
/** 4px, the 8px mark, 4px — what a mark adds between two row boxes. */
export const MARK_SPAN_PX = SEPARATOR_GAP_PX * 2 + SEPARATOR_HEIGHT_PX;
/** A real layout answers in fractional pixels; the drawing is graded to one. */
export const TOLERANCE_PX = 1;

const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE_PX;
const round = (n: number): number => Math.round(n * 100) / 100;
const bottom = (b: Box): number => b.y + b.h;
const centre = (b: Box): number => b.y + b.h / 2;

/** The height the drawing gives a row whose label takes `lines` line boxes. */
export function expectedRowHeight(lines: number, lineHeight: number): number {
  return Math.max(CIRCLE_PX, lines * lineHeight) + 2 * ROW_PADDING_PX;
}

/** The pitch the drawing composes between two adjacent circles. */
export function expectedPitch(above: Box, below: Box): number {
  return above.h / 2 + MARK_SPAN_PX + below.h / 2;
}

/**
 * Grade one palette's reading against C1–C5. Returns one line per violated
 * sentence, empty when the layout is the drawing's.
 */
export function gradeRailReading(reading: RailReading): string[] {
  const bad: string[] = [];
  const say = (code: string, message: string) => bad.push(`${reading.palette} ${code}: ${message}`);

  if (reading.rows.length < 2) say("C0", `the rail read ${reading.rows.length} rows, so no pair can be graded`);
  if (reading.separators.length !== reading.rows.length - 1) {
    say("C0", `${reading.rows.length} rows carry ${reading.separators.length} marks, not ${reading.rows.length - 1}`);
    return bad;
  }

  for (const row of reading.rows) {
    // C1 — the circle is centred in the row's OWN box, and the box is the
    // circle or the label's line boxes, plus the row's own 2px either side.
    if (!near(centre(row.glyph), centre(row.box))) {
      say("C1", `"${row.label}" centres its circle at ${round(centre(row.glyph))} in a row box centred at ${round(centre(row.box))}`);
    }
    // C1 — and the line box the row grows by is the DRAWING's, not a leading
    // chosen here. A row whose lines are 20px composes a 64px three-line box and
    // a 62px pitch beside it, both self-consistent and both off the drawing;
    // only this sentence catches that.
    if (!near(row.lineHeight, LINE_BOX_PX)) {
      say("C1", `"${row.label}" sets a ${round(row.lineHeight)} line box where the drawing's ${FONT_SIZE_PX}px over ${LINE_HEIGHT_RATIO} is ${round(LINE_BOX_PX)}`);
    }
    const want = expectedRowHeight(row.lines, row.lineHeight);
    if (!near(row.box.h, want)) {
      say("C1", `"${row.label}" takes ${row.lines} line box(es) of ${round(row.lineHeight)} and measures ${round(row.box.h)} where the drawing composes ${round(want)}`);
    }
    // C2 — a 24px round mark.
    if (!near(row.glyph.w, CIRCLE_PX) || !near(row.glyph.h, CIRCLE_PX)) {
      say("C2", `"${row.label}" draws a ${round(row.glyph.w)} x ${round(row.glyph.h)} circle, not ${CIRCLE_PX} x ${CIRCLE_PX}`);
    }
    // A circle is `50%`, or any radius at least half the circle — `rounded-full`
    // computes to a very large pixel value rather than to the drawing's literal.
    const radius = Number.parseFloat(row.glyphRadius);
    const round50 = row.glyphRadius.trim().startsWith("50%");
    if (!round50 && !(Number.isFinite(radius) && radius >= CIRCLE_PX / 2)) {
      say("C2", `"${row.label}" rounds its circle to ${row.glyphRadius}, which is not a circle at ${CIRCLE_PX}px`);
    }
  }

  reading.separators.forEach((sep, index) => {
    const above = reading.rows[index]!;
    const below = reading.rows[index + 1]!;
    // C3 — 2 x 8, exactly 4px above and below, 11px in from the rail column.
    if (!near(sep.box.w, SEPARATOR_WIDTH_PX) || !near(sep.box.h, SEPARATOR_HEIGHT_PX)) {
      say("C3", `mark ${index + 1} is ${round(sep.box.w)} x ${round(sep.box.h)}, not ${SEPARATOR_WIDTH_PX} x ${SEPARATOR_HEIGHT_PX}`);
    }
    if (!near(sep.marginTop, SEPARATOR_GAP_PX) || !near(sep.marginBottom, SEPARATOR_GAP_PX)) {
      say("C3", `mark ${index + 1} carries margins ${round(sep.marginTop)} above and ${round(sep.marginBottom)} below, not ${SEPARATOR_GAP_PX} and ${SEPARATOR_GAP_PX}`);
    }
    if (!near(sep.marginLeft, SEPARATOR_INDENT_PX) || !near(sep.box.x - reading.column.x, SEPARATOR_INDENT_PX)) {
      say("C3", `mark ${index + 1} stands ${round(sep.box.x - reading.column.x)} in from the rail column with a ${round(sep.marginLeft)} left margin, not ${SEPARATOR_INDENT_PX}`);
    }
    if (!/^1(\.\d+)?px/.test(sep.radius)) {
      say("C3", `mark ${index + 1} rounds to ${sep.radius}, not 1px`);
    }
    // C4 — siblings in normal flow; the mark's box never overlaps a row's.
    if (sep.position !== "static") {
      say("C4", `mark ${index + 1} is ${sep.position}, not a sibling in normal flow`);
    }
    if (!sep.siblingOfRows) {
      say("C4", `mark ${index + 1} is nested inside a row box instead of standing between two`);
    }
    if (!near(sep.box.y, bottom(above.box) + SEPARATOR_GAP_PX)) {
      say("C4", `mark ${index + 1} starts at ${round(sep.box.y)} where "${above.label}" ends at ${round(bottom(above.box))} plus ${SEPARATOR_GAP_PX}`);
    }
    if (!near(bottom(sep.box), below.box.y - SEPARATOR_GAP_PX)) {
      say("C4", `mark ${index + 1} ends at ${round(bottom(sep.box))} where "${below.label}" starts at ${round(below.box.y)} minus ${SEPARATOR_GAP_PX}`);
    }
    for (const row of reading.rows) {
      if (sep.box.y < bottom(row.box) - TOLERANCE_PX && bottom(sep.box) > row.box.y + TOLERANCE_PX) {
        say("C4", `mark ${index + 1} (${round(sep.box.y)}..${round(bottom(sep.box))}) overlaps the row box of "${row.label}" (${round(row.box.y)}..${round(bottom(row.box))})`);
      }
    }
    // C5 — one rhythm: the same 4px at every pair, and the pitch that follows.
    const pitch = centre(below.glyph) - centre(above.glyph);
    const want = expectedPitch(above.box, below.box);
    if (!near(pitch, want)) {
      say("C5", `the pair "${above.label}" / "${below.label}" composes a ${round(pitch)} pitch where half of ${round(above.box.h)} plus ${MARK_SPAN_PX} plus half of ${round(below.box.h)} is ${round(want)}`);
    }
  });

  return bad;
}

/** The reading as the record prints it — one line per box, both palettes. */
export function describeRailReading(reading: RailReading): string[] {
  const lines = reading.rows.map(
    (row, index) =>
      `${reading.palette} row ${index + 1} "${row.label}": box y ${round(row.box.y)} h ${round(row.box.h)} (${row.lines} x ${round(row.lineHeight)}), circle centre ${round(centre(row.glyph))}, box centre ${round(centre(row.box))}`,
  );
  reading.separators.forEach((sep, index) => {
    lines.push(
      `${reading.palette} mark ${index + 1}: box y ${round(sep.box.y)} h ${round(sep.box.h)} w ${round(sep.box.w)}, margins ${round(sep.marginTop)}/${round(sep.marginBottom)}/${round(sep.marginLeft)}, ${round(sep.box.x - reading.column.x)} in from the column, ${sep.position}`,
    );
  });
  for (let index = 1; index < reading.rows.length; index += 1) {
    const above = reading.rows[index - 1]!;
    const below = reading.rows[index]!;
    lines.push(
      `${reading.palette} pitch ${index}: ${round(centre(below.glyph) - centre(above.glyph))} (the drawing composes ${round(expectedPitch(above.box, below.box))})`,
    );
  }
  return lines;
}
