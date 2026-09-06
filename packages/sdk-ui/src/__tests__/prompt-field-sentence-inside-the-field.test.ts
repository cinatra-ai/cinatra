// ---------------------------------------------------------------------------
// THE SENTENCE IN THE EMPTY FIELD STAYS INSIDE THE FIELD'S BOX
// (cinatra#3222 item 3, fix leg 9).
//
// Design: the ratified drawing, agent run and review surface, §IX and §X —
// "These are five readings of one window, never five windows... it is the same
// window: the same panel above the field, the same field, the same send
// control, in the same place under the work it belongs to. One thing is read
// per surface — THE SENTENCE IN THE EMPTY FIELD, which names what the window
// does where it stands. Nothing else about the window changes from one reading
// to the next."
//
// The window's five sentences are one field's five readings, so the FIELD is
// what accommodates the longest of them. The review reading's sentence is that
// longest one, and at the width the field is drawn at on the review reading it
// wraps to a second line. The sentence used to float over the box, out of the
// flow, contributing no height at all: the box's own minimum came from the
// `rows` prop alone (one 24px line plus 24px of padding), so the second line
// fell past the field's bottom border onto the card ground. The fifth proof
// round measured it on a real run, in both palettes: field box CSS y
// 888.0-935.5, the sentence's second line at 930.5-940.5 — about 5 CSS px
// outside the box that is supposed to contain it.
//
// WHAT IS PINNED HERE. The sentence and the editable box are STACKED IN ONE
// GRID CELL, both of them in that cell's flow, so the cell is as tall as the
// taller of the two and the sentence's last line is inside the field's box for
// a sentence of ANY length — never by shortening or clipping the sentence,
// which the drawing gives as the one thing each reading states.
//
// THE INSTRUMENT. The sdk-ui tier runs in the ROOT vitest project under the
// `node` environment (no DOM — see `prompt-field-primary-variant.test.ts`), so
// the reading here is taken the way that tier takes every reading: the class
// lists are read out of the field's own source and the two boxes are RESOLVED
// from them, exactly as the stylesheet resolves them and as a picture is graded
// on them. The wrap itself is the one thing the harness states, since no
// measurement of text happens here.
//
// BOTH PALETTES: every box is resolved once per palette, with the tokens the
// other palette would scope away removed, so a fit that held in only one
// palette cannot pass.
//
// Run:
//   npx vitest run packages/sdk-ui/src/__tests__/prompt-field-sentence-inside-the-field.test.ts
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(path.join(__dirname, "..", "prompt-field.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Reading the two boxes' class lists out of the field itself.
// ---------------------------------------------------------------------------

/** Fail loudly at load time when the field stops looking like itself. */
function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`prompt-field: ${what}`);
  return value;
}

/** The `cn(...)` call that follows `from`, as its own source text. */
function classCall(from: number): string {
  const open = SOURCE.indexOf("className={cn(", from);
  if (open < 0) throw new Error("prompt-field: the box states its classes through cn()");
  let depth = 0;
  for (let i = open + "className={".length; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === "(") depth += 1;
    if (SOURCE[i] === ")") {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(open, i);
    }
  }
  throw new Error("unterminated cn() call");
}

/** Every class token a `cn(...)` call can contribute. */
function classTokens(call: string): string[] {
  return Array.from(call.matchAll(/"([^"\n]*)"/g))
    .flatMap((m) => m[1]!.split(/\s+/))
    .filter(Boolean);
}

/** The editor area — the one box that holds the sentence and the editable box. */
function editorAreaClasses(): string[] {
  const m = need(
    SOURCE.match(/<div className="([^"]+)">\s*\{isEmpty && placeholder && \(/),
    "the editor area is the element the sentence is rendered inside",
  );
  return m[1]!.split(/\s+/).filter(Boolean);
}

const SENTENCE_AT = SOURCE.indexOf("{isEmpty && placeholder && (");
const EDITABLE_AT = SOURCE.indexOf("ref={editorRef}");
if (SENTENCE_AT < 0 || EDITABLE_AT < SENTENCE_AT) {
  throw new Error("prompt-field: the sentence and the editable box are read in that order");
}

const SENTENCE_TOKENS = classTokens(classCall(SENTENCE_AT));
const EDITABLE_TOKENS = classTokens(classCall(EDITABLE_AT));
const AREA_TOKENS = editorAreaClasses();

/** The field's own minimum, as the field computes it for the window's `rows={1}`. */
const LINE_HEIGHT_PX = Number(
  need(SOURCE.match(/const LINE_HEIGHT_PX = (\d+)/), "states its line box")[1],
);
const PADDING_Y_PX = Number(
  need(SOURCE.match(/const PADDING_Y_PX = (\d+)/), "states its vertical padding")[1],
);
const ROWS_DEFAULT = 1; // the run window mounts the field at `rows={1}`
const EDITABLE_MIN_HEIGHT = ROWS_DEFAULT * LINE_HEIGHT_PX + PADDING_Y_PX;

// ---------------------------------------------------------------------------
// The resolver: utility tokens -> the box the stylesheet composes, per palette.
// ---------------------------------------------------------------------------
const SPACING: Record<string, number> = {
  "0": 0,
  "0.5": 2,
  "1": 4,
  "2": 8,
  "3": 12,
  "4": 16,
  "6": 24,
  "14": 56,
};

/** The tokens that apply in `palette`, with the other palette's removed. */
function inPalette(tokens: string[], palette: "light" | "dark"): string[] {
  return tokens
    .filter((t) => (t.startsWith("dark:") ? palette === "dark" : true))
    .map((t) => (t.startsWith("dark:") ? t.slice("dark:".length) : t));
}

function value(tokens: string[], prop: string): number | null {
  let resolved: number | null = null;
  for (const raw of tokens) {
    const token = raw.startsWith("!") ? raw.slice(1) : raw;
    const m = token.match(new RegExp(`^${prop}-(\\d+(?:\\.\\d+)?|\\[\\d+px\\])$`));
    if (!m) continue;
    resolved = m[1]!.startsWith("[") ? Number(m[1]!.slice(1, -3)) : SPACING[m[1]!]!;
  }
  return resolved;
}

/** The sentence's own box, for a sentence that takes `lines` lines. */
function sentenceBox(tokens: string[], lines: number) {
  const padY = value(tokens, "py") ?? 0;
  const lineHeight = value(tokens, "leading") ?? 0;
  const outOfFlow = tokens.includes("absolute") || tokens.includes("fixed");
  const top = value(tokens, "top") ?? 0;
  return {
    outOfFlow,
    lineHeight,
    top: outOfFlow ? top : 0,
    height: 2 * padY + lines * lineHeight,
    get bottom() {
      return this.top + this.height;
    },
  };
}

/**
 * The FIELD's own box: the editor area's cell. A sentence in the flow of that
 * cell grows it; a sentence out of the flow contributes nothing to it, which is
 * exactly the defect the fifth round measured.
 */
function fieldBoxHeight(sentence: ReturnType<typeof sentenceBox>): number {
  return sentence.outOfFlow
    ? EDITABLE_MIN_HEIGHT
    : Math.max(EDITABLE_MIN_HEIGHT, sentence.height);
}

const PALETTES = ["light", "dark"] as const;
/** One line, the two the review reading's sentence takes at the field's live
 *  width, and a third for a narrower field than the round happened to measure. */
const LINE_COUNTS = [1, 2, 3] as const;

describe.each(PALETTES)("the empty field's sentence, in the %s palette", (palette) => {
  const sentence = inPalette(SENTENCE_TOKENS, palette);
  const editable = inPalette(EDITABLE_TOKENS, palette);
  const area = inPalette(AREA_TOKENS, palette);

  it("is inside the field's box on every line it takes", () => {
    for (const lines of LINE_COUNTS) {
      const box = sentenceBox(sentence, lines);
      const field = fieldBoxHeight(box);
      expect(
        box.bottom,
        `a ${lines}-line sentence ends ${box.bottom - field}px past a ${field}px field`,
      ).toBeLessThanOrEqual(field);
    }
  });

  it("shares ONE grid cell with the editable box, both of them in its flow", () => {
    expect(area).toContain("grid");
    for (const box of [sentence, editable]) {
      expect(box).toContain("col-start-1");
      expect(box).toContain("row-start-1");
      expect(box).not.toContain("absolute");
      expect(box).not.toContain("fixed");
    }
  });

  it("is drawn in the editable box's own box, on both sides", () => {
    // The same line box, the same padding above and below, the same left inset
    // and the same reservation for the send control's corner (fix leg 8): the
    // sentence's box IS the editable box's box, so one cannot outgrow the other.
    for (const prop of ["py", "leading", "pl", "pr"]) {
      expect(value(sentence, prop), `the sentence's ${prop}`).toBe(value(editable, prop));
    }
    expect(value(sentence, "pr")).toBe(56);
  });

  it("is never shortened or clipped to make it fit", () => {
    for (const token of [
      "truncate",
      "text-ellipsis",
      "overflow-hidden",
      "whitespace-nowrap",
    ]) {
      expect(sentence).not.toContain(token);
    }
    expect(sentence.some((t) => t.startsWith("line-clamp-"))).toBe(false);
    // And the field never states a fixed height that a longer sentence could
    // not grow: its `rows` value is a MINIMUM.
    expect(SOURCE).toContain("minHeight: minHeightValue");
  });
});
