/**
 * THE DECISION FLOOR'S OUTLINE TREATMENT MUST READ IN BOTH PALETTES
 * (cinatra#3080, fix leg 9 — the re-grade's fifth departure: "Comment and
 * Regenerate treatments departing and disagreeing between the palettes").
 *
 * The ratified cards drawing gives the floor three weights — "Comment quiet at
 * the left, Regenerate in the OUTLINE treatment and Continue primary at the
 * right" — and the drawing's own rule for that outline is a page-surface fill
 * inside a STRONG stroke. Fix leg 8 asked for exactly that pair by name and
 * repeated it for the dark reading (`dark:border-line-strong dark:bg-surface`),
 * on the stated premise that "those two tokens are themselves redefined per
 * palette".
 *
 * ONLY ONE OF THEM IS. `--surface` is re-declared in `.dark`; `--line-strong` is
 * NOT — and it deliberately never will be, because the etched-rule conformance
 * gate binds to its light value (src/app/__tests__/control-border-contrast.test.ts
 * pins `.dark` as leaving it undeclared). So the dark reading of Regenerate drew
 * the LIGHT palette's full navy (#15213a) over a dark control fill: measured on
 * the live boot at 1440x900, `border-color: rgb(21, 33, 58)` on a
 * `lab(3.87 0.50 -12.27)` ground — a stroke that is not there. The light reading
 * showed the drawing's outline; the dark reading showed a plate with no edge,
 * which is the two palettes disagreeing about one treatment.
 *
 * The product already answers this exact problem with its own token: `--line-control`
 * (cinatra#3107) IS `--line-strong` in the light palette — so the light reading is
 * unchanged, byte for byte — and in the dark palette it is the strengthened
 * white-over-ground control boundary that clears the 3:1 non-text floor.
 *
 * This suite reads the SHIPPED token layer and the SHIPPED component, resolves
 * the stroke the Regenerate control actually asks for in each palette exactly as
 * the cascade does, and pins two things: the light stroke is still the drawing's
 * full navy, and the dark stroke is findable against the ground that control
 * sits on. Nothing here is a screenshot: it is the same reading the browser took,
 * derived from the two files that decide it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { contrastAgainst } from "@/lib/color-contrast";

/** The WCAG floor for a boundary that carries meaning but is not text. */
const NON_TEXT_FLOOR = 3;

const CSS = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
const BAR = readFileSync(
  path.join(process.cwd(), "packages/agents/src/review-decision-bar.tsx"),
  "utf8",
);

function block(selector: string): string {
  const open = CSS.indexOf(`\n${selector} {\n`);
  if (open === -1) throw new Error(`no \`${selector}\` block in globals.css`);
  const start = open + `\n${selector} {\n`.length;
  const end = CSS.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`unterminated \`${selector}\` block`);
  return CSS.slice(start, end);
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const stmt of stripped.split(";")) {
    const m = stmt.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/);
    if (m) out.set(m[1], m[2].replace(/\s+/g, " "));
  }
  return out;
}

const ROOT = declarations(block(":root"));
const CINATRA = declarations(block(".cinatra"));
const DARK = declarations(block(".dark"));

function resolve(theme: Map<string, string>, token: string, seen = new Set<string>()): string {
  if (seen.has(token)) throw new Error(`cyclic token chain at ${token}`);
  seen.add(token);
  const raw = theme.get(token) ?? ROOT.get(token);
  if (raw === undefined) throw new Error(`undeclared token ${token}`);
  const alias = raw.match(/^var\((--[\w-]+)\)$/);
  return alias ? resolve(theme, alias[1], seen) : raw;
}

/**
 * The `className` the Regenerate control carries — the one control the drawing
 * gives the outline treatment. Read from the shipped component so a class that
 * moves takes this assertion with it.
 */
function regenerateClassName(): string {
  const at = BAR.indexOf('data-action="regenerate-review -> changes-requested"');
  expect(at, "the Regenerate control is no longer anchored by its data-action").toBeGreaterThan(0);
  const before = BAR.slice(0, at);
  const open = before.lastIndexOf("<Button");
  expect(open, "no <Button> opens the Regenerate control").toBeGreaterThan(0);
  const element = BAR.slice(open, at);
  const m = element.match(/className="([^"]+)"/);
  expect(m, "the Regenerate control carries no className").not.toBeNull();
  return m![1];
}

/** The colour token a `border-<name>` / `dark:border-<name>` utility resolves to. */
function strokeTokenFor(className: string, palette: "light" | "dark"): string {
  const classes = className.split(/\s+/);
  const wanted = palette === "dark" ? /^dark:border-([\w-]+)$/ : /^border-([\w-]+)$/;
  const hit = classes.map((c) => c.match(wanted)).find((m) => m !== null);
  expect(
    hit,
    `the Regenerate control names no ${palette} border colour — the ${palette} reading ` +
      "then falls to whatever the shared variant strokes, which is the drift this pins",
  ).not.toBeUndefined();
  return `--${hit![1]}`;
}

describe("cinatra#3080 — Regenerate's outline stroke, in both palettes", () => {
  it("keeps the light reading on the drawing's own full-navy stroke", () => {
    const token = strokeTokenFor(regenerateClassName(), "light");
    expect(resolve(ROOT, token)).toBe("#15213a");
    expect(resolve(CINATRA, token)).toBe("#15213a");
  });

  it("draws a FINDABLE stroke in the dark palette, not the light palette's navy", () => {
    const token = strokeTokenFor(regenerateClassName(), "dark");
    const stroke = resolve(DARK, token);
    expect(
      stroke,
      "the dark reading strokes the LIGHT palette's full navy — the outline treatment " +
        "disappears against the dark control fill, so the two palettes disagree",
    ).not.toBe("#15213a");
    // Against every ground this control can sit on in the dark palette.
    for (const [where, groundToken] of [
      ["the control's own fill (--surface)", "--surface"],
      ["the card ground (--card)", "--card"],
      ["the page ground (--background)", "--background"],
    ] as const) {
      const ground = resolve(DARK, groundToken);
      const ratio = contrastAgainst(stroke, ground);
      expect(
        ratio,
        `dark: the outline stroke resolves to ${stroke}; against ${where} (${ground}) that ` +
          `is ${ratio.toFixed(2)}:1, below the ${NON_TEXT_FLOOR}:1 floor for a control boundary`,
      ).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
    }
  });

  it("keeps the fill token the drawing names, which IS redefined per palette", () => {
    const classes = regenerateClassName().split(/\s+/);
    expect(classes).toContain("bg-surface");
    expect(classes).toContain("dark:bg-surface");
    expect(DARK.get("--surface"), "--surface must stay a per-palette token").toBeDefined();
  });
});
