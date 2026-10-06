// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// THE TABLE ZEBRA'S ALTERNATE-ROW BAND, IN BOTH PALETTES (cinatra#3552).
// ---------------------------------------------------------------------------
// WHAT A PERSON SEES. On the Skills directory in the DARK palette every second
// body row sits on a pale grey slab while its ink stays pale, so the extension,
// used-in, skill-id and description cells of those rows are hard to read. The
// light palette is fine.
//
// THE ZEBRA IS ONE UTILITY ON ONE SHARED PRIMITIVE. `TableBody` carries
// "[&_tr:last-child]:border-0 [&_tr:nth-child(even)]:bg-stripe-light/50"
// (src/components/ui/table.tsx:43, intent stated at :35-37), and the band
// composites over the table frame's own ground, `bg-background`
// (src/components/ui/paginated-table.tsx:116-120). No page overrides it and no
// `dark:` variant of it exists anywhere in the product.
//
// THE CAUSE IS THE TOKEN, NOT THE UTILITY. `--stripe-light: #e3e8ee` is
// declared for the LIGHT palette only — src/app/globals.css:35 (`:root`) and
// :204 (`.cinatra`), mirrored at packages/design/src/tokens.css:42 and :158 —
// and AT THE BRANCH BASE neither `.dark` block declared it. So in the dark
// palette the band inherited the light-palette literal from `:root` and painted
// it at 50 percent over a near-black ground: a mid grey that sat ABOVE the page
// it is meant to whisper against, carrying the muted cells at 1.71:1. Each
// `.dark` block now declares the token as that palette's own surface step, and
// the cases below read the declaration rather than a line number, because a
// line range quoted in a comment goes stale the moment either sheet moves.
//
// WHY THIS READS THE STYLESHEET RATHER THAN A BROWSER. jsdom implements
// neither Tailwind's utility generation nor custom-property substitution, so no
// `getComputedStyle` in this environment can tell a wrong colour from NO
// declaration at all — the reason
// packages/agents/src/__tests__/schedule-card-chosen-row-indigo-3279.test.tsx
// reads the same two halves, and the machinery below is that file's. This file
// computes the band the way the cascade does: it takes the band UTILITY off the
// rendered `[data-slot="table-body"]`, maps it through the `@theme inline`
// registration, resolves the token inside each palette block, and composites it
// over that palette's `--background` with the repository's own colour maths
// (src/lib/color-contrast.ts).
//
// ONE ADAPTATION OF THAT FILE'S `utility()` IS REQUIRED. It drops any class
// matching /^(?:.*-)?\[/, and the band class IS such a class, so a verbatim
// copy would silently read no utility at all (section 5 exercises exactly
// that). `bandUtility` below takes the class by its arbitrary-variant prefix
// and fails loudly when that prefix is absent or carried more than once.
//
//   pnpm exec vitest run \
//     src/components/ui/__tests__/table-zebra-band-dark-3552.test.tsx --maxWorkers=2

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import {
  compositeOver,
  contrastRatio,
  parseCssColor,
  relativeLuminance,
  type Rgba,
} from "@/lib/color-contrast";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// The stylesheets, parsed as structure rather than searched as text.
// ---------------------------------------------------------------------------

const GLOBALS_CSS = readFileSync(
  path.resolve(__dirname, "../../../app/globals.css"),
  "utf8",
);
const TOKENS_CSS = readFileSync(
  path.resolve(__dirname, "../../../../packages/design/src/tokens.css"),
  "utf8",
);

type Rule = { selector: string; body: string };

function topLevelRules(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  for (let i = 0; i < stripped.length; i += 1) {
    const c = stripped[i];
    if (c === "{") {
      if (depth === 0) bodyStart = i + 1;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        rules.push({
          selector: stripped
            .slice(selectorStart, bodyStart - 1)
            .trim()
            .replace(/\s+/g, " "),
          body: stripped.slice(bodyStart, i),
        });
        selectorStart = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      selectorStart = i + 1;
    }
  }
  return rules;
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const flat = body.replace(/\{[^{}]*\}/g, "");
  for (const part of flat.split(";")) {
    const m = /^\s*(--[A-Za-z0-9-]+)\s*:\s*([\s\S]+)$/.exec(part);
    if (m) out.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
  }
  return out;
}

/** Every declaration of every block with this selector, in stylesheet order. */
function blockOf(rules: Rule[], selector: string, where: string): Map<string, string> {
  const out = new Map<string, string>();
  let seen = 0;
  for (const rule of rules) {
    // A rule may GROUP its selectors (`.dark, .dark *`). The block counts when
    // any grouped PART is exactly this selector; reading the whole selector
    // text instead would let a grouped re-declaration of a token hide from this
    // reading, while a descendant-only block (`.dark .sidebar-brand`) still
    // does not count, because its declarations reach only that element.
    const parts = rule.selector.split(",").map((part) => part.trim());
    if (!parts.includes(selector)) continue;
    seen += 1;
    for (const [k, v] of declarations(rule.body)) out.set(k, v);
  }
  if (seen === 0) throw new Error(`no \`${selector}\` block in ${where}`);
  return out;
}

const GLOBALS_RULES = topLevelRules(GLOBALS_CSS);
const TOKENS_RULES = topLevelRules(TOKENS_CSS);

const THEME = blockOf(GLOBALS_RULES, "@theme inline", "globals.css");
const ROOT_TOKENS = blockOf(GLOBALS_RULES, ":root", "globals.css");
const PALETTE = {
  light: blockOf(GLOBALS_RULES, ".cinatra", "globals.css"),
  dark: blockOf(GLOBALS_RULES, ".dark", "globals.css"),
} as const;
type Palette = keyof typeof PALETTE;

/** The portable mirror the app ships to other surfaces. */
const TOKENS_ROOT = blockOf(TOKENS_RULES, ":root", "tokens.css");
const TOKENS_PALETTE = {
  light: blockOf(TOKENS_RULES, ".cinatra", "tokens.css"),
  dark: blockOf(TOKENS_RULES, ".dark", "tokens.css"),
} as const;

/** Resolve a token to a literal by walking `var(...)` inside one palette block,
 *  falling back to the sheet's `:root` the way the cascade does for a value the
 *  block does not re-declare. */
function resolveIn(
  root: Map<string, string>,
  tokens: Map<string, string>,
  name: string,
  seen = new Set<string>(),
): string {
  if (seen.has(name)) throw new Error(`token cycle at ${name}`);
  seen.add(name);
  const raw = tokens.get(name) ?? root.get(name);
  if (raw === undefined) throw new Error(`no token ${name}`);
  const m = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(raw);
  return m ? resolveIn(root, tokens, m[1]!, seen) : raw;
}

/** The two token layers, each read against ITS OWN `:root` fallback: the host
 *  sheet the app compiles and the portable sheet the package ships. Reading the
 *  portable layer through the host sheet's `:root` would let a broken portable
 *  value borrow a correct host one, which is the same shape of lie this file
 *  exists to refuse. */
const SHEETS = {
  host: { root: ROOT_TOKENS, palette: PALETTE },
  portable: { root: TOKENS_ROOT, palette: TOKENS_PALETTE },
} as const;
type Sheet = keyof typeof SHEETS;

const resolve = (
  tokens: Map<string, string>,
  name: string,
  sheet: Sheet = "host",
) => resolveIn(SHEETS[sheet].root, tokens, name, new Set<string>());

function colour(literal: string): Rgba {
  const parsed = parseCssColor(literal);
  expect(parsed, `unsupported colour notation: ${literal}`).not.toBeNull();
  return parsed!;
}

/** The literal a colour token paints in one palette, through the `@theme
 *  inline` registration that makes the utility real at all. */
function registered(token: string, palette: Palette, sheet: Sheet = "host"): string {
  const reg = THEME.get(`--color-${token}`);
  expect(
    reg,
    `\`--color-${token}\` is not registered in @theme inline, so the utility emits no rule at all`,
  ).toBeDefined();
  const varName = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(reg!);
  if (!varName) return reg!;
  return resolve(SHEETS[sheet].palette[palette], varName[1]!, sheet);
}

// ---------------------------------------------------------------------------
// The band utility, taken off the primitive the product actually paints.
// ---------------------------------------------------------------------------

type Utility = { token: string; alpha: number | null };

/** The arbitrary variant the zebra is drawn through. */
const BAND_VARIANT = "[&_tr:nth-child(even)]:";

/** The band colour utility a `TableBody` class list carries, split into the
 *  colour name and its opacity modifier (`bg-stripe-light/50` → 50).
 *
 *  This is `utility()` of schedule-card-chosen-row-indigo-3279.test.tsx with
 *  ONE required adaptation: that helper drops every class matching
 *  /^(?:.*-)?\[/ and the band class IS one, so a verbatim copy would read no
 *  utility at all. A missing prefix, a second carrier of it, or a
 *  variant-qualified sibling that would outrank the plain reading FAILS here
 *  rather than being ignored. */
function bandUtility(className: string): Utility {
  const classes = className.split(/\s+/).filter(Boolean);
  const carriers = classes.filter(
    (c) => c.includes("nth-child(even)") && /(?:^|:)bg-/.test(c),
  );
  expect(
    carriers.length,
    `expected exactly one alternate-row background utility in: ${className}`,
  ).toBe(1);
  const carrier = carriers[0]!;
  expect(
    carrier.startsWith(BAND_VARIANT),
    `the alternate-row band carries a qualifier ahead of \`${BAND_VARIANT}\` in: ${carrier}`,
  ).toBe(true);
  const rest = carrier.slice(BAND_VARIANT.length);
  expect(
    rest.startsWith("bg-"),
    `the alternate-row band is qualified after \`${BAND_VARIANT}\` in: ${carrier}`,
  ).toBe(true);
  const [name, mod] = rest.slice("bg-".length).split("/");
  return { token: name!, alpha: mod === undefined ? null : Number(mod) };
}

/** The table body the product paints, mounted from the primitive itself so the
 *  class this file reads is the class the Skills directory renders. */
function tableBody(): HTMLElement {
  const { container } = render(
    <Table>
      <TableBody>
        <TableRow>
          <TableCell>Send the weekly digest</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Reconcile the CRM</TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  );
  const body = container.querySelector<HTMLElement>('[data-slot="table-body"]');
  expect(body, "the table body renders").not.toBeNull();
  return body!;
}

/** The band as a person sees it: the token at its opacity, composited over the
 *  table frame's own ground (`bg-background`, paginated-table.tsx:116-120). */
function paintedBand(
  palette: Palette,
  sheet: Sheet = "host",
): { band: Rgba; ground: Rgba; util: Utility } {
  const util = bandUtility(tableBody().className);
  expect(util.alpha, "the zebra band is painted at an opacity").not.toBeNull();
  const tokens = SHEETS[sheet].palette[palette];
  const ground = colour(resolve(tokens, "--background", sheet));
  const ink = {
    ...colour(registered(util.token, palette, sheet)),
    a: util.alpha! / 100,
  };
  return { band: compositeOver(ink, ground), ground, util };
}

/** The inks the Skills directory puts on those rows: the four muted cells take
 *  `text-muted-foreground` and the skill-name cell inherits the body ink
 *  (packages/skills/src/plugin-pages.tsx:326-338). */
function inks(palette: Palette, sheet: Sheet = "host"): { muted: Rgba; body: Rgba } {
  const tokens = SHEETS[sheet].palette[palette];
  return {
    muted: colour(resolve(tokens, "--muted-foreground", sheet)),
    body: colour(resolve(tokens, "--foreground", sheet)),
  };
}

/** WCAG 2.x body-text floor. */
const BODY_TEXT_FLOOR = 4.5;

// ---------------------------------------------------------------------------
// 1. THE DARK PALETTE — the band the proof round graded false.
// ---------------------------------------------------------------------------
describe("the alternate-row band in the DARK palette", () => {
  it("is declared for the dark palette at all, in BOTH token layers, with one declaration text", () => {
    const inGlobals = PALETTE.dark.get("--stripe-light");
    const inTokens = TOKENS_PALETTE.dark.get("--stripe-light");
    expect(
      inGlobals,
      "the `.dark` block of src/app/globals.css does not declare --stripe-light, so the band inherits the light literal from :root",
    ).toBeDefined();
    expect(
      inTokens,
      "the `.dark` block of packages/design/src/tokens.css does not declare --stripe-light, so the portable layer carries the same defect",
    ).toBeDefined();
    expect(
      inTokens,
      "the host layer and the portable layer must carry the SAME declaration text",
    ).toBe(inGlobals);
  });

  it("draws a DARK band: below the palette's own --surface-muted step and above the un-banded ground", () => {
    const { band, ground } = paintedBand("dark");
    const surfaceMuted = relativeLuminance(
      colour(resolve(PALETTE.dark, "--surface-muted")),
    );
    // The dark palette's own surface ladder, as declared: --background 0.0021,
    // --surface 0.0044, --surface-strong 0.0092, --surface-muted 0.0216.
    expect(surfaceMuted).toBeCloseTo(0.0216, 4);
    expect(relativeLuminance(ground)).toBeCloseTo(0.0021, 4);
    // At the branch base this reads 0.1843 — a mid grey 4.50:1 ABOVE the page
    // it is supposed to whisper against.
    expect(relativeLuminance(band)).toBeLessThan(surfaceMuted);
  });

  it("is still a zebra: the band is strictly lighter than the un-banded ground", () => {
    const { band, ground } = paintedBand("dark");
    expect(relativeLuminance(band)).toBeGreaterThan(relativeLuminance(ground));
  });

  it("carries the muted cells — extension, used in, skill id, description — over the body-text floor", () => {
    const { band } = paintedBand("dark");
    // At the branch base this reads 1.71:1.
    expect(contrastRatio(inks("dark").muted, band)).toBeGreaterThanOrEqual(
      BODY_TEXT_FLOOR,
    );
  });

  it("carries the skill-name cell's body ink over the same floor", () => {
    const { band } = paintedBand("dark");
    // At the branch base this reads 4.28:1.
    expect(contrastRatio(inks("dark").body, band)).toBeGreaterThanOrEqual(
      BODY_TEXT_FLOOR,
    );
  });

  it("draws that same dark band in the PORTABLE token layer, resolved through that layer's own tokens", () => {
    // The declaration-text case above proves the two sheets carry the same
    // WORDS. This one proves the portable sheet's own values make those words
    // mean the same thing: a broken portable `--surface-muted` or `--background`
    // would leave every other case here green.
    const { band, ground } = paintedBand("dark", "portable");
    const { muted, body } = inks("dark", "portable");
    const surfaceMuted = relativeLuminance(
      colour(resolve(TOKENS_PALETTE.dark, "--surface-muted", "portable")),
    );
    expect(relativeLuminance(band)).toBeLessThan(surfaceMuted);
    expect(relativeLuminance(band)).toBeGreaterThan(relativeLuminance(ground));
    expect(contrastRatio(muted, band)).toBeGreaterThanOrEqual(BODY_TEXT_FLOOR);
    expect(contrastRatio(body, band)).toBeGreaterThanOrEqual(BODY_TEXT_FLOOR);
  });

  it("leaves the UN-banded rows where they already read", () => {
    const { ground } = paintedBand("dark");
    const { muted, body } = inks("dark");
    expect(contrastRatio(muted, ground)).toBeGreaterThanOrEqual(BODY_TEXT_FLOOR);
    expect(contrastRatio(body, ground)).toBeGreaterThanOrEqual(BODY_TEXT_FLOOR);
  });
});

// ---------------------------------------------------------------------------
// 2. THE LIGHT PALETTE IS UNCHANGED — the reading the proof round graded true.
// ---------------------------------------------------------------------------
describe("the alternate-row band in the LIGHT palette", () => {
  it("keeps the fabric stripe literal in every light block of both token layers", () => {
    for (const [where, tokens] of [
      ["globals.css :root", ROOT_TOKENS],
      ["globals.css .cinatra", PALETTE.light],
      ["tokens.css :root", TOKENS_ROOT],
      ["tokens.css .cinatra", TOKENS_PALETTE.light],
    ] as const) {
      expect(tokens.get("--stripe-light")?.toLowerCase(), where).toBe("#e3e8ee");
    }
  });

  it("still composites to the same whisper over its own ground", () => {
    const { band, ground } = paintedBand("light");
    // #e3e8ee at 50 percent over #f1f1ed. The checklist quotes this band as
    // rgb(234, 236, 238); the exact composite is (234, 236.5, 237.5) — the same
    // colour, the checklist's triple truncating the green channel's half and
    // carrying the blue channel's up.
    expect(band.r).toBeCloseTo(234, 6);
    expect(band.g).toBeCloseTo(236.5, 6);
    expect(band.b).toBeCloseTo(237.5, 6);
    expect(contrastRatio(band, ground)).toBeCloseTo(1.04, 2);
  });

  it("keeps its muted and body inks exactly where they read", () => {
    const { band } = paintedBand("light");
    const { muted, body } = inks("light");
    expect(contrastRatio(muted, band)).toBeCloseTo(5.05, 2);
    expect(contrastRatio(body, band)).toBeCloseTo(13.57, 2);
  });
});

// ---------------------------------------------------------------------------
// 3. THE FIX IS IN THE TOKEN, NOT IN THE UTILITY.
// ---------------------------------------------------------------------------
describe("the utility the shared primitive carries", () => {
  it("still names the stripe token at its own opacity", () => {
    const util = bandUtility(tableBody().className);
    expect(util.token).toBe("stripe-light");
    expect(util.alpha).toBe(50);
  });

  it("still registers the stripe tokens as colour utilities, so the class emits a real rule", () => {
    expect(THEME.get("--color-stripe-light")).toBe("var(--stripe-light)");
  });
});

// ---------------------------------------------------------------------------
// 4. THE READING REFUSES THE WAYS IT COULD LIE. A substitute for a browser is
//    only worth the cases it cannot be fooled by, and each case below is
//    SYNTHETIC, so none of them is pinned to a live token's state.
// ---------------------------------------------------------------------------
describe("the reading itself", () => {
  it("would have read NOTHING through the helper it adapts, which is why it adapts it", () => {
    // `utility()` of schedule-card-chosen-row-indigo-3279.test.tsx drops any
    // class matching this pattern; the band class is exactly such a class.
    expect(/^(?:.*-)?\[/.test(`${BAND_VARIANT}bg-stripe-light/50`)).toBe(true);
  });

  it("sees a token re-declared by a GROUPED palette selector, through the reader itself", () => {
    // Read through `blockOf`, not by splitting the selector here: a reader that
    // lost its grouped-selector support would keep a hand-split check green
    // while a grouped re-declaration hid from every other case in this file.
    const grouped = topLevelRules(
      ".dark { --stripe-light: #000000; } .dark, .dark * { --stripe-light: #ffffff; }",
    );
    expect(blockOf(grouped, ".dark", "synthetic").get("--stripe-light")).toBe(
      "#ffffff",
    );
    // A descendant-only block still does not count as the palette block.
    expect(() =>
      blockOf(topLevelRules(".dark .sidebar { --stripe-light: #ffffff; }"), ".dark", "synthetic"),
    ).toThrow();
  });

  it("reports the :root fallback a palette block leaves undeclared, which is the shape of this defect", () => {
    const rules = topLevelRules(
      ":root { --stripe-light: #e3e8ee; } .dark { --background: #020618; }",
    );
    const root = blockOf(rules, ":root", "synthetic");
    const dark = blockOf(rules, ".dark", "synthetic");
    expect(dark.has("--stripe-light")).toBe(false);
    expect(resolveIn(root, dark, "--stripe-light")).toBe("#e3e8ee");
  });

  it("refuses a dark-qualified band utility instead of ignoring it", () => {
    expect(() =>
      bandUtility(`${BAND_VARIANT}bg-stripe-light/50 dark:${BAND_VARIANT}bg-surface-muted`),
    ).toThrow();
    expect(() =>
      bandUtility(`${BAND_VARIANT}dark:bg-surface-muted`),
    ).toThrow();
  });

  it("refuses a class list that carries no band utility at all", () => {
    expect(() => bandUtility("[&_tr:last-child]:border-0")).toThrow();
  });
});
