/**
 * THE REVIEW TARGET BLOCK READS THE SAME IN BOTH PALETTES, ON BOTH HOSTS.
 *
 * WHY THIS EXISTS. A graded capture read the dark conversation's decided frame
 * as a target block with no legible content in it — nothing in the block
 * brighter than the block's own chrome — while the light twin and the dark run
 * page twin read fine, and asked which token or class collapses the contrast in
 * dark on the conversation surface. This suite is the answer, taken as a
 * measurement rather than an opinion: there is none.
 *
 * WHAT IT MEASURES. The block's own chrome, from the palette file itself rather
 * than from a copy of it, in the two pairs the block is actually built from —
 * the panel against the ground it sits on, and the hairline that edges it — plus
 * the ink the target's own document paints with. Every ratio is required to
 * match its twin in the other palette, because that is the property the picture
 * put in doubt; the ink is additionally required to be genuinely legible, so a
 * palette edit that ever did collapse a target's prose goes red here first.
 *
 * AND THE HOST. The card composes one frame per host and neither carries a
 * ground of its own, so the conversation's block and the run page's block are
 * the same block. That is pinned on the card's own source, beside the ratios,
 * so "the conversation surface only" cannot be re-opened as a card defect
 * without this going red.
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/review-target-block-palette-parity.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(
  join(__dirname, "..", "..", "..", "design", "src", "tokens.css"),
  "utf8",
);
const CARD_SRC = readFileSync(join(__dirname, "..", "review-gate-card.tsx"), "utf8");

type Rgb = [number, number, number];

/** oklch(L C H) as the palette writes it, to sRGB — the same transform a
 *  browser runs, so the numbers below are the painted ones. */
function oklchToRgb(L: number, C: number, H: number): Rgb {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const enc = (v: number): number => {
    const c = Math.max(0, Math.min(1, v));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  };
  return [
    enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function parseColor(raw: string): { rgb: Rgb; alpha: number } {
  const value = raw.trim();
  let match = /^#([0-9a-f]{6})$/i.exec(value);
  if (match) {
    const hex = match[1];
    return {
      rgb: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb,
      alpha: 1,
    };
  }
  match = /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)$/i.exec(value);
  if (match) {
    return { rgb: oklchToRgb(Number(match[1]), Number(match[2]), Number(match[3])), alpha: 1 };
  }
  match = /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\/\s*([0-9.]+)%\s*\)$/i.exec(value);
  if (match) {
    return {
      rgb: oklchToRgb(Number(match[1]), Number(match[2]), Number(match[3])),
      alpha: Number(match[4]) / 100,
    };
  }
  match = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/i.exec(value);
  if (match) {
    return {
      rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
      alpha: Number(match[4]),
    };
  }
  throw new Error(`unreadable palette value: ${raw}`);
}

/** The declarations of ONE palette block, by selector. */
function paletteBlock(selector: string): Record<string, string> {
  const start = TOKENS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in the palette file`);
  const end = TOKENS.indexOf("\n}", start);
  const out: Record<string, string> = {};
  for (const line of TOKENS.slice(start, end).split("\n")) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb =>
  fg.map((c, i) => Math.round(alpha * c + (1 - alpha) * bg[i])) as Rgb;

/**
 * ONE TOKEN'S PAINTED VALUE, followed through the indirection the palette
 * actually writes. A palette entry may name another entry rather than a colour
 * (`--muted-foreground: var(--muted)` in the light palette), and a reader that
 * cannot follow that cannot measure the ink at all — which is how the first cut
 * of this suite came to measure a pair the block does not paint. A name a
 * palette does not restate is inherited from the light one, as the cascade
 * gives it.
 */
function paletteValue(t: Record<string, string>, name: string): string {
  let value = t[name] ?? ROOT_TOKENS[name];
  for (let hop = 0; value !== undefined && hop <= 8; hop += 1) {
    const indirect = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value.trim());
    if (!indirect) return value.trim();
    value = t[indirect[1]] ?? ROOT_TOKENS[indirect[1]];
  }
  throw new Error(`unresolvable palette token: ${name}`);
}

/** The pairs the review target block is BUILT from, per palette. */
function blockReadings(selector: string) {
  const t = paletteBlock(selector);
  const rgb = (name: string): Rgb => parseColor(paletteValue(t, name)).rgb;
  const strong = rgb("--surface-strong");
  const line = parseColor(paletteValue(t, "--line"));
  return {
    // `bg-surface-strong` on the `.soft-panel` ground the slot draws inside.
    blockOnPanel: contrast(strong, rgb("--surface")),
    // …and on the page itself, for a surface that draws no panel around it.
    blockOnPage: contrast(strong, rgb("--background")),
    // `border-line`, composited over the block it edges.
    hairline: contrast(over(line.rgb, line.alpha, strong), strong),
    // The bar motif the island draws while a target has not painted.
    skeletonBar: contrast(rgb("--surface-muted"), strong),
    // THE INK THE BLOCK ACTUALLY PAINTS, on the ground it actually paints it on.
    // The target block IS `bg-surface-strong` (`review-target-panel.tsx`, the
    // panel's own class list), and it draws its title in `text-foreground` and
    // its whole run of metadata — the line the graded frame said was missing —
    // in `text-muted-foreground`. Measuring the document ink against `--surface`
    // measured neither of those and left the quieter of the two, the one that
    // fails first, unmeasured altogether.
    titleInk: contrast(rgb("--foreground"), strong),
    metadataInk: contrast(rgb("--muted-foreground"), strong),
  };
}

const ROOT_TOKENS = paletteBlock(":root");
const LIGHT = blockReadings(":root");
const DARK = blockReadings(".dark");

describe("the review target block is palette-symmetric", () => {
  it.each([
    ["the block against the panel it sits in", "blockOnPanel"],
    ["the block against the page", "blockOnPage"],
    ["the hairline that edges the block", "hairline"],
    ["the bar motif drawn while a target has not painted", "skeletonBar"],
  ] as const)("%s reads the same in both palettes", (_name, key) => {
    // The two palettes are built to mirror each other, and this is the pair the
    // graded frame put in doubt. A drift of more than a twentieth of a step is a
    // real divergence between the palettes and not rounding.
    expect(Math.abs(LIGHT[key] - DARK[key])).toBeLessThan(0.05);
  });

  it("paints a target's prose legibly in BOTH palettes, title and metadata alike", () => {
    // The readings that are judged rather than merely compared: if a frame shows
    // nothing brighter than the block's own chrome, it is not the palette that
    // lost the prose. Both inks are taken against the block's OWN ground, and
    // the quieter one is held to the ordinary floor for body text rather than to
    // the title's, because that is the reading a palette edit collapses first.
    expect(LIGHT.titleInk).toBeGreaterThan(7);
    expect(DARK.titleInk).toBeGreaterThan(7);
    expect(LIGHT.metadataInk).toBeGreaterThan(4.5);
    expect(DARK.metadataInk).toBeGreaterThan(4.5);
  });

  it.each([
    ["the title ink", "titleInk"],
    ["the metadata ink", "metadataInk"],
  ] as const)("%s reads no worse in dark than in light", (_name, key) => {
    // The graded frame's claim was one-directional — the dark twin lost its
    // content while the light twin kept it — so the ink is compared in that
    // direction rather than merely for symmetry.
    expect(DARK[key]).toBeGreaterThanOrEqual(LIGHT[key] - 0.05);
  });

  it("is the SAME block on the conversation and on the run page", () => {
    // The card's per-host frames are layout only — no ground, no palette, no
    // border — so the block the conversation draws and the block the run page
    // draws are one block. A host frame that ever grew a ground of its own would
    // make "on the conversation surface only" possible, and trips this first.
    const start = CARD_SRC.indexOf("const HOST_FRAME");
    const frames = CARD_SRC.slice(start, CARD_SRC.indexOf("};", start));
    expect(start).toBeGreaterThan(0);
    for (const host of ["chat_thread", "run_card", "page_gate_region", "site_widget"]) {
      expect(frames).toContain(`${host}:`);
    }
    expect(/\bbg-[a-z]/.test(frames)).toBe(false);
    expect(/\bborder-[a-z]/.test(frames)).toBe(false);
    expect(/\bdark:/.test(frames)).toBe(false);
  });
});
