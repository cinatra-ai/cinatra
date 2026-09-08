/**
 * THE RUN'S LAST STEP CARRIES NAMED TYPE TOKENS (cinatra#3029, fix leg 3).
 *
 * The second proof round graded the drawn surface 44 of 44 against the ratified
 * drawing's artifact review, section I.2 — and the design system's own gate was
 * RED on the very file that draws those rows: five arbitrary `text-[…]` /
 * `tracking-[…]` literals, plus a raw button in the surface's drawn test.
 *
 * The gate's rule is not a style preference: a bracket literal is a size that
 * belongs to one file, so the type scale cannot be moved from the token table
 * and the site drifts a pixel at a time. The gate's own vocabulary is the named
 * type-scale tokens.
 *
 * THE DRAWING'S OWN NUMBERS, transcribed from section I.2's two specimens at
 * design main 033a697c (the inline styles the drawing itself carries):
 *
 *   the step's heading   font-size:14px; font-weight:700   ("What this run made")
 *   the category phrase  font-size:12px; line-height:1.5
 *   a row's title        font-size:13px; font-weight:700
 *   the type tag         font-size:10px   (.tag.ext)
 *   the Used tag         font-size:10px   (.tag)
 *   the mono fact line   font-size:10px; letter-spacing:0.04em
 *   the Open control     font-size:12px   (.btn.link)
 *   the empty reading    font-size:12.5px; line-height:1.55
 *
 * Three of those sizes had NO named token: 13px, 12.5px, and the 0.04em
 * tracking. The nearest standard size is a whole pixel away in each case, and a
 * pixel away from the drawing is a departure the second round's 44 of 44 does
 * not survive. So the token table NAMES them — the same answer the table
 * already gives twice in its own comments (`--text-scope-caption`,
 * `--text-scope-empty-title`): the site carries a token, never a bracket
 * literal. The 10px tags need no new token: `text-badge-xs` IS 10px, and the
 * file had been drawing them at 11px — a pixel off the drawing that this leg
 * also corrects.
 *
 * THE NAMES ARE ROLES, NOT SURFACES. `--text-row-title` is a row's own title
 * in any bordered list row, `--text-reading` is the sentence a surface reports
 * back with, `--text-fact-line` is the mono line of facts under a title. Each
 * is a step of the scale the whole site may reuse — a token named after the
 * one surface that first needed it would be a bracket literal wearing a name.
 * This file asserts the names AND the drawing's values, in both token tables,
 * so a rename cannot drift the two tables apart.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-made-step-type-tokens.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

const SURFACE = "packages/agents/src/run-made-step-surface.tsx";
const DRAWN_TEST = "packages/agents/src/__tests__/run-made-step-drawn.test.tsx";
const TOKEN_TABLES = ["src/app/globals.css", "packages/design/src/theme.css"];

/** The drawing's own size, and the token that must carry it. */
const DRAWN_SIZES: ReadonlyArray<readonly [token: string, value: string, drawn: string]> = [
  ["--text-row-title", "13px", "a row's title"],
  ["--text-reading", "12.5px", "the empty reading"],
  ["--text-fact-line", "10px", "the mono fact line"],
  ["--text-fact-line--letter-spacing", "0.04em", "the mono fact line's tracking"],
];

describe("§I.2 — the drawing's sizes are named in the token table", () => {
  for (const table of TOKEN_TABLES) {
    for (const [token, value, drawn] of DRAWN_SIZES) {
      it(`${table} names ${token} at the drawing's ${value} (${drawn})`, () => {
        expect(read(table)).toContain(`${token}: ${value};`);
      });
    }
  }
});

/**
 * The gate reads string literals, not prose: this file's own transcription of
 * the banned utilities would otherwise answer for the code. Comments out, then
 * scan what actually reaches a className.
 */
function code(rel: string): string {
  return read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("§I.2 — the drawn surface carries no bracket type literal", () => {
  it("draws no arbitrary text-[…] font size", () => {
    const offenders = code(SURFACE)
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /(^|[^a-zA-Z0-9_-])text-\[/.test(line));
    expect(offenders).toEqual([]);
  });

  it("draws no arbitrary tracking-[…] letter-spacing", () => {
    const offenders = code(SURFACE)
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /(^|[^a-zA-Z0-9_-])-?tracking-\[/.test(line));
    expect(offenders).toEqual([]);
  });

  it("carries the named token at every seam the drawing sizes", () => {
    const src = code(SURFACE);
    // the type tag and the Used tag — the drawing's 10px, which text-badge-xs IS
    expect(src.match(/text-badge-xs font-semibold/g)?.length).toBe(2);
    expect(src).toContain("text-row-title font-bold");
    expect(src).toContain("text-reading leading-[1.55]");
    expect(src).toContain("font-mono text-fact-line");
  });
});

describe("the drawn test goes through the shadcn wrapper", () => {
  it("renders no raw button", () => {
    expect(code(DRAWN_TEST)).not.toMatch(/<button[\s>]/);
    expect(code(DRAWN_TEST)).toMatch(/<Button[\s>]/);
  });
});
