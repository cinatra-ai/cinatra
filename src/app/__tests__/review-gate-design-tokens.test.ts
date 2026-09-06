// THE REVIEW GATE'S COLOURS, READ OUT OF THE STYLESHEET (cinatra#3141 items 2-5).
//
// Three colours the ratified drawing names — its indigo (`#364e81`), its
// `--mustard-ink` (`#7a5a1f`) and its `--logo` mustard (`#c79545`) — were
// written into the review-gate components as the utility classes `text-blue`,
// `bg-mustard-ink/15` and `border-logo/40`. None of the three was ever
// REGISTERED as a colour: the `@theme inline` block binds no `--color-blue`, no
// `--color-mustard-ink` and no `--color-logo`, so every one of those utilities
// emitted no CSS at all and the elements fell back to inherited ink on their
// own ground. The measurement said so — chip ground `#ffffff` / `#f7f7f3`, text
// `#15213a`, no blue and no mustard in six frames.
//
// WHY THIS SUITE READS THE STYLESHEET RATHER THAN A BROWSER. A utility that
// names an unregistered colour is not a wrong value a renderer could report —
// it is NO declaration, and jsdom implements neither Tailwind's utility
// generation nor custom-property substitution, so no `getComputedStyle` in this
// environment can tell the two apart. What CAN be read exactly is the pair the
// defect lives in: which colours the stylesheet REGISTERS, and which colours the
// components ASK FOR. This suite reads both and requires them to agree, which is
// the guard the acceptance asks for — "an unregistered token cannot land again
// silently" — and it fails on the shipped code for all three names.
//
// THE VALUES ARE THE DRAWING'S OWN, resolved through the token chain the app
// declares, so a token renamed underneath is caught here rather than in a
// picture taken later.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const GLOBALS_CSS = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");

const REVIEW_GATE_SOURCES = [
  "packages/agents/src/review-gate-card.tsx",
  "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel.tsx",
] as const;

// ---------------------------------------------------------------------------
// The stylesheet, parsed as structure rather than searched as text.
// ---------------------------------------------------------------------------

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
          selector: stripped.slice(selectorStart, bodyStart - 1).trim().replace(/\s+/g, " "),
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

const RULES = topLevelRules(GLOBALS_CSS);

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  // Nested blocks (a media query, a nested rule) carry no top-level token.
  const flat = body.replace(/\{[^{}]*\}/g, "");
  for (const part of flat.split(";")) {
    const m = /^\s*(--[A-Za-z0-9-]+)\s*:\s*([\s\S]+)$/.exec(part);
    if (m) out.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
  }
  return out;
}

/** Every declaration of every block with this selector, in stylesheet order. */
function block(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  let seen = 0;
  for (const rule of RULES) {
    if (rule.selector !== selector) continue;
    seen += 1;
    for (const [k, v] of declarations(rule.body)) out.set(k, v);
  }
  if (seen === 0) throw new Error(`no \`${selector}\` block in globals.css`);
  return out;
}

const THEME = block("@theme inline");
const ROOT_TOKENS = block(":root");
const CINATRA_TOKENS = block(".cinatra");
const DARK_TOKENS = block(".dark");

/** Resolve a token to a literal by walking `var(...)` inside one palette block,
 *  falling back to `:root` the way the cascade does for a block that only
 *  increments it. */
function resolve(tokens: Map<string, string>, name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`token cycle at ${name}`);
  seen.add(name);
  const raw = tokens.get(name) ?? ROOT_TOKENS.get(name);
  if (raw === undefined) throw new Error(`no token ${name}`);
  const m = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(raw);
  return m ? resolve(tokens, m[1]!, seen) : raw;
}

/** The colour names the app REGISTERS as Tailwind utilities. */
const REGISTERED = new Set(
  [...THEME.keys()].filter((k) => k.startsWith("--color-")).map((k) => k.slice("--color-".length)),
);

/** Colour names CSS itself supplies — never registered, never broken. */
const CSS_OWN = new Set(["transparent", "current", "inherit", "white", "black"]);

// ---------------------------------------------------------------------------
// The colour utilities the review-gate components ask for.
// ---------------------------------------------------------------------------

const UTILITY = /\b(?:text|bg|border|fill|stroke|ring|from|via|to|decoration|outline|shadow|accent|caret|divide|placeholder)-((?:[a-z][a-z0-9]*)(?:-[a-z0-9]+)*)(?:\/(?:\[[^\]]+\]|\d+))?\b/g;

/** Utility STEMS that are not colours at all — sizes, sides, styles, and the
 *  shared radius/positional vocabulary these components use. Listed rather than
 *  guessed so a real colour can never hide behind the filter. */
const NOT_A_COLOUR = new Set([
  "sm", "xs", "2xs", "xl", "2xl", "lg", "md", "base", "left", "right", "center", "top", "bottom",
  "b", "t", "l", "r", "x", "y", "0", "none", "auto", "wrap", "nowrap", "balance", "pretty",
  "clip", "ellipsis", "solid", "dashed", "dotted", "hidden", "collapse", "separate", "fixed",
  "control", "panel", "badge-xs", "badge-2xs", "full", "start", "end", "justify",
]);

function utilityColoursIn(source: string): Set<string> {
  // Comments carry PROSE, and prose contains hyphenated words that read as
  // utilities ("text-valued"). The scan is of the code these files ship.
  const text = readFileSync(join(ROOT, source), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const found = new Set<string>();
  for (const m of text.matchAll(UTILITY)) {
    const name = m[1]!;
    if (NOT_A_COLOUR.has(name)) continue;
    // A bare size/side token that also names nothing in the theme and nothing in
    // CSS is reported: that is exactly the defect class this guard exists for.
    found.add(name);
  }
  return found;
}

/** The gate header's source, for the reading that there is no glyph in it. */
function gateCardSource(): string {
  return readFileSync(join(ROOT, REVIEW_GATE_SOURCES[0]), "utf8");
}

/** The radius utility on a class list — `rounded-chip` yields `chip`. */
function radiusUtilityOf(classes: string): string | null {
  const m = /\brounded-([a-z0-9-]+)\b/.exec(classes);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------

describe("#3141 items 2-4 — the drawing's colours are REGISTERED colours", () => {
  it("every colour utility the review-gate components ask for resolves to a registered theme colour", () => {
    const unregistered: string[] = [];
    for (const source of REVIEW_GATE_SOURCES) {
      for (const name of utilityColoursIn(source)) {
        if (REGISTERED.has(name) || CSS_OWN.has(name)) continue;
        unregistered.push(`${source}: ${name}`);
      }
    }
    expect(unregistered).toEqual([]);
  });

  it("registers the drawing's mustard ink as a colour (`--color-mustard-ink`)", () => {
    expect(REGISTERED.has("mustard-ink")).toBe(true);
  });

  it("the drawing's indigo chip colour is #364e81 in both light palettes", () => {
    // The drawing's chip: `color: #364e81`, over `rgba(54,78,129,0.10)`, inside
    // `rgba(54,78,129,0.30)` — one hue at three alphas, which is what an
    // `info/10` + `info/30` pair emits.
    expect(resolve(ROOT_TOKENS, "--info").toLowerCase()).toBe("#364e81");
    expect(resolve(CINATRA_TOKENS, "--info").toLowerCase()).toBe("#364e81");
    expect(resolve(ROOT_TOKENS, THEME.get("--color-info")!.replace(/^var\(|\)$/g, "")).toLowerCase()).toBe("#364e81");
  });

  it("the pinned marker's mustard ink is #7a5a1f, and is NOT the muted grey beside it on the line", () => {
    const ink = resolve(ROOT_TOKENS, "--mustard-ink").toLowerCase();
    expect(ink).toBe("#7a5a1f");
    expect(resolve(CINATRA_TOKENS, "--mustard-ink").toLowerCase()).toBe("#7a5a1f");
    expect(ink).not.toBe(resolve(ROOT_TOKENS, "--muted").toLowerCase());
  });

  it("carries a mustard ink in the dark palette too, distinct from the light one", () => {
    const dark = resolve(DARK_TOKENS, "--mustard-ink");
    expect(DARK_TOKENS.has("--mustard-ink")).toBe(true);
    expect(dark).not.toBe(resolve(ROOT_TOKENS, "--mustard-ink"));
  });

  // THE GLYPH IS GONE, AND WITH IT ITS TILE (cinatra#3080, fix leg 7). Items 2-4
  // of the earlier grading fixed the tile's size, tint and radius because a tile
  // was drawn. The ratified drawing's header strip is the word "Review" and the
  // mono target-naming line beside it and nothing else — no glyph appears in any
  // frame of it — and an independent grade charged the clipboard tile as an
  // unspecified element. So the reading these two tests pin is now the ABSENCE,
  // and the mustard ink they were about is read where the drawing does put it:
  // the "· pinned" segment of the target header's identity line.
  it("draws NO glyph before the gate header's word — the drawing draws none", () => {
    const card = gateCardSource();
    expect(card).not.toContain("ClipboardCheck");
    expect(card).not.toMatch(/bg-brand-mustard\/\[0\.16\]/);
    expect(card).not.toContain("size-[30px]");
  });

  // ITEM 4 of the first proof round grading, dark half. The tile measured 28 x 28
  // at radius 8 px in the light palette and radius 10 px in the DARK one, where
  // the drawing fixes 8 px for both: the drawing gives the tile one radius, not
  // one per palette, and the app draws one treatment.
  //
  // WHY THE TILE MOVED AND NOT THE TOKEN. `rounded-lg` resolves through
  // `--radius-lg: var(--radius)`, and `--radius` is 0.5rem in the light palette
  // block and 0.625rem in the dark one — so the 10 px reading was every
  // `rounded-lg` element in the product in dark, not this tile. Re-pointing the
  // shared token would have moved all of them for one graded tile. The tile is
  // pointed at a radius that is already 8 px in BOTH palettes instead, and this
  // test reads the resolution rather than the class name so a later rename
  // cannot quietly restore the split.
  it("keeps the drawing's mustard ink where the drawing does put it — on `· pinned`", () => {
    const card = gateCardSource();
    // §IV of the ratified review drawing: "@cinatra-ai/email:draft · revision
    // rev_8f3a… · pinned · Team · Private · text/html · updated 8 min ago", with
    // `· pinned` in var(--mustard-ink) and every other segment muted.
    expect(card).toMatch(/text-mustard-ink[^"]*"[^>]*>\s*· pinned/);
    expect(resolve(CINATRA_TOKENS, "--mustard-ink").toLowerCase()).toBe("#7a5a1f");
    expect(DARK_TOKENS.has("--mustard-ink")).toBe(true);
  });
});

describe("#3141 item 5 — rendered markdown reads as a document, not a paragraph", () => {
  // "The renderer fills the slot exactly as it would on the detail surface"
  // (§IV). The host ships Tailwind's preflight, which normalizes h1-h6 to
  // inherit size and weight, and registered NO rule for the `markdown-body`
  // hook the renderers emit and no `.prose` layer — so a heading inside a
  // review target landed at paragraph size by construction.
  const HOOKS = [".markdown-body", "[data-markdown-body]", ".prose"];

  /** The declarations one selector carries inside the typography layer. */
  function typographyRule(selectorPart: string): Map<string, string> {
    const layer = RULES.find((r) => r.selector === "@layer components");
    expect(layer, "a @layer components block in globals.css").toBeTruthy();
    const nested = topLevelRules(layer!.body);
    // The element must be a whole selector token — `.prose h1` must not answer
    // for `p`, and `.markdown-body p` must not answer for `.prose`.
    const token = new RegExp(`(?:^|[\\s,])${selectorPart}(?=[\\s,{]|$)`);
    const hit = nested.find((r) => token.test(r.selector));
    expect(hit, `a typography rule for ${selectorPart}`).toBeTruthy();
    const out = new Map<string, string>();
    for (const part of hit!.body.split(";")) {
      const m = /^\s*([a-z-]+)\s*:\s*([\s\S]+)$/.exec(part);
      if (m) out.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
    }
    return out;
  }

  const em = (v: string | undefined) => {
    expect(v, "a declared font-size").toBeTruthy();
    const m = /^([0-9.]+)em$/.exec(v!);
    expect(m, `an em font-size, got ${v}`).toBeTruthy();
    return Number(m![1]);
  };

  it("registers a typography layer for the markdown-body hook every renderer emits", () => {
    const layer = RULES.find((r) => r.selector === "@layer components");
    expect(layer).toBeTruthy();
    for (const hook of HOOKS) expect(layer!.body).toContain(hook);
  });

  it("h1, h2 and h3 draw strictly larger and heavier than a paragraph in the same body", () => {
    const p = typographyRule("p");
    const h1 = typographyRule("h1");
    const h2 = typographyRule("h2");
    const h3 = typographyRule("h3");
    // The paragraph is the body's own size — the baseline every heading must
    // clear. Declared in em so the layer rides whatever size the host set.
    expect(em(p.get("font-size"))).toBe(1);
    expect(em(h1.get("font-size"))).toBeGreaterThan(em(h2.get("font-size")));
    expect(em(h2.get("font-size"))).toBeGreaterThan(em(h3.get("font-size")));
    expect(em(h3.get("font-size"))).toBeGreaterThan(em(p.get("font-size")));
    for (const h of [h1, h2, h3]) {
      expect(Number(h.get("font-weight"))).toBeGreaterThan(Number(p.get("font-weight") ?? "400"));
    }
  });

  it("gives the rest of a document its readings too — emphasis, links, code and lists", () => {
    const layer = RULES.find((r) => r.selector === "@layer components")!.body;
    for (const selector of ["strong", "em", "a", "code", "ul", "ol", "li", "blockquote"]) {
      expect(layer, `a rule for ${selector}`).toMatch(new RegExp(`\\b${selector}\\b`));
    }
  });
});
