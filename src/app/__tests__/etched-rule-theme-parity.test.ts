/**
 * THE ETCHED SECTION RULE FOLLOWS THE THEME (cinatra#3142 §2, acceptance 4 and 5).
 *
 *   pnpm exec vitest run src/app/__tests__/etched-rule-theme-parity.test.ts
 *
 * The rule that closes the tab strip was measured at grey 32 of 255 in BOTH
 * themes on twelve frames, while the application's own hairlines beside it
 * measured 224 in light and 23 in dark. 32 of 255 is the relative luminance of
 * `#15213a`, the light palette's full navy: the rule does not flip because
 * `--line-strong`, the token `.divider-etched` paints from, was never declared
 * for the dark palette and cascaded in at its light value.
 *
 * The drawing states the principle the fix follows: "All hairlines use navy at
 * low alpha. Major section dividers use full navy as paired rules — the
 * etched-glass treatment. Never use a neutral grey on a divider." Over a dark
 * ground the inverted pairing is white-over-ground, which is the vocabulary the
 * dark palette already states for `--line` and `--line-control`; the section
 * rule takes the same vocabulary at the strength its role asks for. The paired
 * 1px/5px-gap geometry is untouched — the drawing draws the pair, and #3106
 * ruled it intended, so this is a token fix and NEVER a second divider style.
 *
 * The assertions read the SHIPPED token layer and composite every alpha over the
 * grounds a section rule actually sits on, so they are made on normalized
 * computed values rather than on source strings.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { contrastAgainst, parseCssColor } from "@/lib/color-contrast";

/**
 * How far the dark reading may fall below the light one. The light reading is
 * the reference the drawing already sanctions; the criterion is light-versus-
 * dark parity, so the tolerance is stated here and nowhere else.
 */
const PARITY_TOLERANCE = 1.5;

/** The floor a mark that carries meaning but is not text may never fall under. */
const NON_TEXT_FLOOR = 3;

const SOURCES = {
  "src/app/globals.css": readFileSync(
    path.join(process.cwd(), "src/app/globals.css"),
    "utf8",
  ),
  "packages/design/src/tokens.css": readFileSync(
    path.join(process.cwd(), "packages/design/src/tokens.css"),
    "utf8",
  ),
} as const;

/** The declaration body of a top-level block, by its selector. */
function block(css: string, selector: string): string {
  const open = css.indexOf(`\n${selector} {\n`);
  if (open === -1) throw new Error(`no \`${selector}\` block`);
  const start = open + `\n${selector} {\n`.length;
  const end = css.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`unterminated \`${selector}\` block`);
  return css.slice(start, end);
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

/** Resolve a token through its `var()` chain, falling back to `:root`. */
function resolve(css: string, selector: string, token: string): string {
  const theme = declarations(block(css, selector));
  const root = declarations(block(css, ":root"));
  let value = theme.get(token) ?? root.get(token);
  for (let hop = 0; hop < 8; hop += 1) {
    const alias = /^var\((--[\w-]+)\)$/.exec(value ?? "");
    if (!alias) break;
    value = theme.get(alias[1]) ?? root.get(alias[1]);
  }
  if (!value) throw new Error(`${selector}: ${token} does not resolve`);
  return value;
}

/** The grounds a major section rule sits on. */
const GROUND_TOKENS = ["--background", "--surface", "--surface-muted"] as const;

describe("`--line-strong` has a dark value", () => {
  for (const [label, css] of Object.entries(SOURCES)) {
    it(`${label}: the dark palette declares it rather than inheriting the light navy`, () => {
      const dark = declarations(block(css, ".dark"));
      expect(
        dark.get("--line-strong"),
        "the dark palette leaves --line-strong inherited, so every etched section " +
          "rule in the dark theme is painted in the light palette's full navy",
      ).toBeDefined();
    });

    it(`${label}: it resolves to a different computed value under dark than under light`, () => {
      const light = parseCssColor(resolve(css, ":root", "--line-strong"));
      const dark = parseCssColor(resolve(css, ".dark", "--line-strong"));
      expect(light, "the light --line-strong must parse").not.toBeNull();
      expect(dark, "the dark --line-strong must parse").not.toBeNull();
      expect(
        [dark!.r, dark!.g, dark!.b, dark!.a],
        "the two palettes paint the section rule in the same ink",
      ).not.toEqual([light!.r, light!.g, light!.b, light!.a]);
    });

    it(`${label}: every --line token the light palette declares is declared in dark too`, () => {
      const root = declarations(block(css, ":root"));
      const dark = declarations(block(css, ".dark"));
      const lineTokens = [...root.keys()]
        .filter((name) => name.startsWith("--line"))
        .sort();
      expect(lineTokens.length, "the light palette must declare line tokens").toBeGreaterThan(0);
      const missing = lineTokens.filter((name) => !dark.has(name));
      expect(
        missing,
        `the dark palette does not declare ${missing.join(", ")} — a line token ` +
          "left out cascades in at its light value, and a hairline drawn in the " +
          "wrong ink for its ground is no hairline at all",
      ).toEqual([]);
    });
  }
});

describe("the etched rule is visible in dark", () => {
  for (const [label, css] of Object.entries(SOURCES)) {
    for (const ground of GROUND_TOKENS) {
      it(`${label}: on ${ground}, the dark reading holds parity with the light one`, () => {
        const lightRatio = contrastAgainst(
          resolve(css, ":root", "--line-strong"),
          resolve(css, ":root", ground),
        );
        const darkRatio = contrastAgainst(
          resolve(css, ".dark", "--line-strong"),
          resolve(css, ".dark", ground),
        );
        expect(
          darkRatio,
          `the section rule reads ${darkRatio.toFixed(2)}:1 against ${ground} in dark ` +
            `while the light palette reads ${lightRatio.toFixed(2)}:1 — a shortfall ` +
            `beyond the ${PARITY_TOLERANCE} tolerance this test states`,
        ).toBeGreaterThanOrEqual(lightRatio - PARITY_TOLERANCE);
        expect(
          darkRatio,
          `the section rule reads ${darkRatio.toFixed(2)}:1 against ${ground} in dark`,
        ).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
      });
    }
  }
});

describe("the fix is the token, never a second divider style", () => {
  it("`.divider-etched` still paints the drawing's paired 1px lines with a 5px gap", () => {
    const css = SOURCES["src/app/globals.css"];
    const start = css.indexOf(".divider-etched {");
    expect(start, "the etched-rule utility must still exist").toBeGreaterThan(-1);
    const body = css.slice(start, css.indexOf("}", start));
    expect(body).toContain("height: 7px");
    for (const stop of ["var(--line-strong) 0", "var(--line-strong) 1px", "var(--line-strong) 6px", "var(--line-strong) 7px"]) {
      expect(body, `the etched rule must paint ${stop}`).toContain(stop);
    }
    expect(body).toContain("transparent 1px");
    expect(body).toContain("transparent 6px");
  });

  it("no palette introduces a divider token beside the section rule", () => {
    for (const [label, css] of Object.entries(SOURCES)) {
      for (const selector of [":root", ".cinatra", ".dark"]) {
        const names = [...declarations(block(css, selector)).keys()];
        const strays = names.filter((n) => /^--divider/.test(n));
        expect(strays, `${label} ${selector}: ${strays.join(", ")}`).toEqual([]);
      }
    }
  });
});
