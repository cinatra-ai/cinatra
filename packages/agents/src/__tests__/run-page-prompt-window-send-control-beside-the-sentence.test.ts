/**
 * THE SEND CONTROL STANDS BESIDE THE SENTENCE, NOT ON TOP OF IT (cinatra#3222
 * item 3, fix leg 8).
 *
 * The ratified drawing, agent run and review surface, §X — "One window, five
 * readings":
 *
 *   "on every one of them it is the same window: the same panel above the
 *    field, the same field, the same send control, in the same place under the
 *    work it belongs to. One thing is read per surface — the sentence in the
 *    empty field, which names what the window does where it stands."
 *
 * WHAT THE FOURTH PROOF ROUND MEASURED. On the REVIEW reading the send control
 * stood ON the sentence: the field's editable box reserves the control's own
 * corner (`pr-14`), and the floating sentence beside it reserved NOTHING — it
 * carried the left inset and no right one — so the review reading's sentence,
 * the longest of the drawing's five, ran its last line under the round control.
 * A sentence a control sits on is not the sentence the drawing reads.
 *
 * WHAT IS PINNED HERE: the sentence's own box clears the control's corner, by
 * the SAME reservation the field's editable box makes, and that reservation is
 * at least the corner the control actually occupies — all three read from the
 * field's own tokens rather than typed in, so a change to the control's size or
 * place fails here instead of agreeing with a literal.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-page-prompt-window-send-control-beside-the-sentence.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { RUN_WINDOW_PLACEHOLDERS } from "../hitl-conversation-panel";

function repoFile(relative: string): string {
  const cwd = process.cwd();
  for (const candidate of [`${cwd}/${relative}`, `${cwd}/../../${relative}`]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error(`file not found: ${relative}`);
}

const SPACING: Record<string, number> = {
  "0": 0,
  "1": 4,
  "2": 8,
  "3": 12,
  "4": 16,
  "8": 32,
  "12": 48,
  "14": 56,
  "16": 64,
};

/** The px value of a spacing token, as the stylesheet resolves it. */
function spacing(token: string): number {
  const value = SPACING[token];
  expect(value, `spacing token ${token} is known to this reading`).not.toBeUndefined();
  return value!;
}

const FIELD = repoFile("packages/sdk-ui/src/prompt-field.tsx");

/**
 * The class list of the one element whose class string contains `marker` — the
 * whole `cn(...)` block it is written in, so a conditional half (the field's
 * own left split) is read with the rest of the box rather than missed.
 */
function classListContaining(marker: string): string[] {
  const lines = FIELD.split("\n");
  const at = lines.findIndex((line) => line.includes(marker));
  expect(at, `the field draws ${marker}`).toBeGreaterThan(-1);
  const block = lines.slice(at, at + 4).join(" ");
  const quoted = block.match(/"[^"]*"/g);
  expect(quoted, `the class string beside ${marker}`).not.toBeNull();
  return quoted!
    .flatMap((chunk) => chunk.slice(1, -1).split(/\s+/))
    .filter(Boolean);
}

/** The right inset a class list reserves — `pr-*`, in px. */
function rightPadding(classes: readonly string[]): number | null {
  for (const token of classes) {
    const m = token.match(/^pr-(\d+)$/);
    if (m) return spacing(m[1]!);
  }
  return null;
}

describe("the review reading's sentence is not occluded by the send control", () => {
  // The send control's own corner: where it sits and how wide it is, read from
  // the control's own tokens.
  const control = classListContaining("absolute bottom-2 right-2");
  const right = control.find((t) => /^right-\d+$/.test(t))!;
  const width = control.find((t) => /^w-\d+$/.test(t))!;
  const corner = spacing(right.slice("right-".length)) + spacing(width.slice("w-".length));

  // Both boxes are read by the tokens that name them. The sentence is no longer
  // drawn out of the flow (cinatra#3222 item 3, fix leg 9): it shares ONE grid
  // cell with the editable box so the field's box grows to hold every line of
  // it, which is what keeps the sentence inside the field. The corner it has to
  // clear is the same corner either way.
  const editor = classListContaining("block w-full min-w-0 overflow-y-auto");
  const placeholder = classListContaining("pointer-events-none col-start-1 row-start-1");

  it("reserves the control's corner in the field's editable box", () => {
    const reserved = rightPadding(editor);
    expect(reserved).not.toBeNull();
    expect(reserved!).toBeGreaterThanOrEqual(corner);
  });

  it("reserves the SAME corner in the sentence's own box", () => {
    const reserved = rightPadding(placeholder);
    expect(reserved, "the sentence clears the control's corner").not.toBeNull();
    expect(reserved!).toBe(rightPadding(editor));
    expect(reserved!).toBeGreaterThanOrEqual(corner);
  });

  it("mirrors the field's left inset on the same box, so the two are one box", () => {
    // The sentence already follows the field's left split; the right one is the
    // half that was missing. Both halves are now stated the SAME way on the two
    // boxes — as the box's own padding (fix leg 9) — rather than as an offset on
    // one and a padding on the other.
    expect(placeholder.join(" ")).toContain("pl-");
    expect(editor.join(" ")).toContain("pl-");
  });

  it("is the reading whose sentence is long enough to reach the control", () => {
    const sentences = Object.values(RUN_WINDOW_PLACEHOLDERS);
    const review = RUN_WINDOW_PLACEHOLDERS.review;
    expect(review).toBe("Ask Cinatra about this review, or ask for changes to the work…");
    expect(Math.max(...sentences.map((s) => s.length))).toBe(review.length);
  });
});
