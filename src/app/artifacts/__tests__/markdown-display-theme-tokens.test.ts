/**
 * THE TOKENS THE MARKDOWN DISPLAY DRAWS FROM, READ IN BOTH THEMES.
 *
 * cinatra#3026 (epic #3023, lifecycle-c W2). The markdown display ships its own
 * stylesheet and writes NO colour of its own: every colour it draws is one of
 * this application's named custom properties, so the display follows the theme
 * rather than carrying a palette. That contract only holds if the properties it
 * names are declared, and declared DISTINCTLY, in BOTH themes — and this file is
 * the half of that statement the application owns. The display's own half (which
 * property each construct is named from) is pinned in the display's package.
 *
 * TWO MEASUREMENTS MADE THIS NECESSARY.
 *
 * The active tab and its 2px underline measured a near-white slate in the dark
 * theme where the ratified drawing asks for indigo — "the inactive one slate,
 * the active one indigo under a 2px indigo underline". The cause is in this
 * file: `--primary` is the indigo hex in the light theme and is ALIASED to
 * `--accent` in the dark one, where `--accent` is a pale slate. `--info` is the
 * indigo the application declares in its own right in both.
 *
 * And the Code view measured as a blank white panel in the light theme with the
 * document present in the DOM. The editable Code view is a transparent textarea
 * over the highlighted text; the control-ground rule below is UNLAYERED, and an
 * unlayered rule beats the layered utility that made the textarea transparent,
 * so the control ground painted an opaque sheet over the document. It reads the
 * light theme's own class, which is why the same view drew correctly in dark.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  path.resolve(__dirname, "..", "..", "..", "..", "src", "app", "globals.css"),
  "utf8",
);

/** The declaration block of a top-level rule, by its exact selector. */
function block(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, `no ${selector} block in globals.css`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  const close = CSS.indexOf("\n}", open);
  return CSS.slice(open + 1, close);
}

/** A custom property's declared value inside one theme block, chased through
 *  one level of aliasing so `--primary: var(--accent)` reads as the slate it
 *  actually resolves to rather than as an alias name. */
function token(themeBlock: string, name: string): string {
  const direct = themeBlock.match(new RegExp(`(?:^|\\n)\\s*--${name}:\\s*([^;]+);`));
  expect(direct, `no --${name} in this theme`).toBeTruthy();
  const value = (direct as RegExpMatchArray)[1].trim();
  const alias = value.match(/^var\(--([a-z0-9-]+)\)$/);
  return alias ? token(themeBlock, alias[1]) : value;
}

const LIGHT = block(".cinatra");
const DARK = block(".dark");

describe("the display's syntax colours are declared in BOTH themes (cinatra#3026)", () => {
  // The four constructs the drawing names — a heading, an emphasis marker, link
  // syntax and a code span — plus the marker colour the view also carries.
  const SYNTAX = ["info", "destructive", "success", "warning"];

  it("every syntax token is declared in the light theme and in the dark one", () => {
    for (const name of SYNTAX) {
      expect(token(LIGHT, name), `--${name} in light`).toBeTruthy();
      expect(token(DARK, name), `--${name} in dark`).toBeTruthy();
    }
  });

  it("the syntax tokens are pairwise DISTINCT in each theme — four constructs, four colours", () => {
    expect(new Set(SYNTAX.map((n) => token(LIGHT, n))).size).toBe(SYNTAX.length);
    expect(new Set(SYNTAX.map((n) => token(DARK, n))).size).toBe(SYNTAX.length);
  });

  it("no syntax token collapses onto the ground it is drawn on", () => {
    for (const [theme, name] of [
      [LIGHT, "light"],
      [DARK, "dark"],
    ] as const) {
      const ground = [token(theme, "background"), token(theme, "surface")];
      for (const syntax of SYNTAX) {
        expect(ground, `--${syntax} in ${name}`).not.toContain(token(theme, syntax));
      }
    }
  });
});

describe("the tab strip's indigo is a token that is indigo in both themes", () => {
  it("--info is the SAME indigo in light and is still a saturated colour in dark", () => {
    expect(token(LIGHT, "info")).toBe("#364e81");
    // Dark restates it rather than aliasing it away.
    expect(token(DARK, "info")).not.toBe(token(DARK, "accent"));
  });

  /**
   * THE MEASUREMENT THAT NAMED THE DEFECT, kept as a test so the reasoning
   * cannot quietly stop being true. `--primary` is NOT usable as an indigo: the
   * dark theme aliases it to the pale slate `--accent`, which is exactly what
   * the dark tab strip measured.
   */
  it("--primary is NOT indigo in the dark theme — it is the pale accent", () => {
    expect(token(LIGHT, "primary")).toBe("#364e81");
    expect(token(DARK, "primary")).toBe(token(DARK, "accent"));
    expect(token(DARK, "primary")).not.toBe(token(DARK, "info"));
  });
});

describe("the control ground the Code view's editor has to answer", () => {
  it("is written UNLAYERED and scoped to the light theme's own class", () => {
    // If this rule is ever moved into a cascade layer, or stops being scoped to
    // the theme class, the display's own override can be re-read rather than
    // left as a rule nobody remembers the reason for.
    expect(CSS).toMatch(/\.cinatra textarea:not\(\[data-slot="input-group-control"\]\)/);
    const at = CSS.indexOf('.cinatra textarea:not([data-slot="input-group-control"])');
    const before = CSS.slice(0, at);
    const opened = (before.match(/@layer [a-z, ]+\{/g) ?? []).length;
    const closed = (before.match(/\n\}/g) ?? []).length;
    expect(opened, "the control ground moved into a cascade layer").toBeLessThanOrEqual(closed);
  });

  it("gives that ground the strong surface, which is opaque white in the light theme", () => {
    expect(token(LIGHT, "surface-strong")).toBe("#ffffff");
  });
});
