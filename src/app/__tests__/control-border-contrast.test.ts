/**
 * Control-boundary contrast floor (cinatra#3107).
 *
 *   pnpm exec vitest run src/app/__tests__/control-border-contrast.test.ts
 *
 * Every text input, textarea, select trigger and input group draws its resting
 * outline from `--input` (`border border-input`). In the dark palette that
 * token was aliased to `--line` — the SECTION-DIVIDER hairline, white at 10%
 * alpha — which composites to about 1.2 to 1.3 to 1 over the dark grounds: a
 * boundary nobody can find until they click into the field. The light palette
 * measured about 13 to 1 for the same token, so nothing in a light review ever
 * showed it.
 *
 * This suite reads the SHIPPED token layer (src/app/globals.css), resolves the
 * `--input` chain per theme block exactly as the cascade does, composites any
 * alpha over each ground a control actually sits on, and pins the ratio at the
 * 3:1 non-text floor — in BOTH themes, so the value cannot regress silently the
 * way it did here. It also pins what must NOT move: the divider hairline
 * (`--line`) and the etched-rule ink (`--line-strong`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { contrastAgainst } from "@/lib/color-contrast";

/** The WCAG floor for a boundary that carries meaning but is not text. */
const NON_TEXT_FLOOR = 3;

const CSS = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

/** The declaration body of a top-level block, by its selector. */
function block(selector: string): string {
  const open = CSS.indexOf(`\n${selector} {\n`);
  if (open === -1) throw new Error(`no \`${selector}\` block in globals.css`);
  const start = open + `\n${selector} {\n`.length;
  const end = CSS.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`unterminated \`${selector}\` block`);
  return CSS.slice(start, end);
}

/** `--name: value;` pairs of a block, comments stripped. */
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

/**
 * Resolve a token through its `var()` chain within a theme, falling back to
 * `:root` for anything the theme does not re-declare — the cascade's own rule.
 */
function resolve(theme: Map<string, string>, token: string, seen = new Set<string>()): string {
  if (seen.has(token)) throw new Error(`cyclic token chain at ${token}`);
  seen.add(token);
  const raw = theme.get(token) ?? ROOT.get(token);
  if (raw === undefined) throw new Error(`undeclared token ${token}`);
  const alias = raw.match(/^var\((--[\w-]+)\)$/);
  return alias ? resolve(theme, alias[1], seen) : raw;
}

/** The grounds a form control sits on: the page, a card, and its own fill. */
function grounds(theme: Map<string, string>) {
  return {
    "the page ground (--background)": resolve(theme, "--background"),
    "a card ground (--card)": resolve(theme, "--card"),
    "the control's own fill (--surface-strong)": resolve(theme, "--surface-strong"),
  };
}

const THEMES: Array<[string, Map<string, string>]> = [
  ["light (:root)", ROOT],
  ["light (.cinatra)", CINATRA],
  ["dark (.dark)", DARK],
];

describe("--input, the resting outline of every form control", () => {
  for (const [name, theme] of THEMES) {
    it(`reaches the ${NON_TEXT_FLOOR}:1 non-text floor on every ground in the ${name} palette`, () => {
      const ink = resolve(theme, "--input");
      for (const [where, ground] of Object.entries(grounds(theme))) {
        const ratio = contrastAgainst(ink, ground);
        expect(
          ratio,
          `${name}: --input resolves to ${ink}; against ${where} (${ground}) that is ` +
            `${ratio.toFixed(2)}:1, below the ${NON_TEXT_FLOOR}:1 floor for a control boundary`,
        ).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
      }
    });
  }

  it("keeps the light reading at the full-navy value it always had", () => {
    expect(resolve(ROOT, "--input")).toBe("#15213a");
    expect(resolve(CINATRA, "--input")).toBe("#15213a");
    expect(
      contrastAgainst(resolve(ROOT, "--input"), resolve(ROOT, "--background")),
    ).toBeGreaterThan(12);
  });

  it("is stated as a line token in both themes, never as a literal at a call site", () => {
    for (const [name, theme] of THEMES) {
      expect(theme.get("--input"), `${name}: --input must alias a line token`).toBe(
        "var(--line-control)",
      );
    }
  });
});

describe("the tokens that must NOT move with it", () => {
  it("leaves the section-divider hairline untouched in both themes", () => {
    expect(ROOT.get("--line")).toBe("rgba(21, 33, 58, 0.14)");
    expect(CINATRA.get("--line")).toBe("rgba(21, 33, 58, 0.14)");
    expect(DARK.get("--line")).toBe("oklch(1 0 0 / 10%)");
  });

  /**
   * REVERSED DELIBERATELY (cinatra#3142). This assertion used to require the
   * dark palette NOT to declare `--line-strong`, on the reading that the
   * etched-rule conformance gate bound to the light navy. That reading was
   * wrong twice over: the gate binds to whatever `--line-strong` resolves to in
   * the palette under test, not to a literal; and leaving the token out is
   * precisely what painted every etched section rule in the dark theme in the
   * light palette's near-black navy — measured at grey 32 of 255 in BOTH themes
   * on twelve frames of the agent run page.
   *
   * What #3107 needed from this test survives unchanged and is what is asserted
   * below: #3107 rebound the CONTROL boundary to its own `--line-control` and
   * must not have moved the section-rule ink WITH it, and the LIGHT reading of
   * `--line-strong` is still the drawing's full navy. The dark value's own
   * floor and its light-versus-dark parity are owned by
   * src/app/__tests__/etched-rule-theme-parity.test.ts.
   */
  it("leaves the light etched paired-line ink untouched, so the control-boundary rebind moved the control boundary alone", () => {
    expect(ROOT.get("--line-strong")).toBe("#15213a");
    expect(CINATRA.get("--line-strong")).toBe("#15213a");
  });

  it("gives the etched paired-line ink a dark value of its own rather than the light navy", () => {
    expect(
      DARK.get("--line-strong"),
      "the dark palette must declare --line-strong: left inherited, every etched " +
        "section rule in the dark theme is painted in the light palette's full navy",
    ).toBeDefined();
    expect(DARK.get("--line-strong")).not.toBe(ROOT.get("--line-strong"));
  });
});
