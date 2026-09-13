// @vitest-environment jsdom
//
// THE ISLAND'S DARK PALETTE (cinatra#2931, epic #2926 W4) — the TOKEN half of
// "one card, drawn by its renderer, on every host".
//
// The island carries the host's palette on a WRAPPER inside its own document,
// because a page cannot write its document root's class list. That is enough for
// every colour a utility reads DIRECTLY: `@theme inline` binds
// `--color-surface-strong` straight to `var(--surface-strong)`, so the utility
// re-reads the token at the element it paints and a palette class anywhere above
// that element is honoured.
//
// It is NOT enough for the ALIAS layer `:root` declares over those tokens —
// `--border: var(--line)`, `--muted-foreground: var(--muted)`, and the rest. A
// custom property is substituted where it is DECLARED and then inherits its
// COMPUTED value, so an alias declared on the document root resolves against the
// ROOT's raw tokens once and hands the answer down; a palette class one element
// below cannot change it by redefining the token underneath. `.cinatra` re-
// declares the whole alias layer and so reproduces itself wherever it lands;
// `.dark` was written as an increment on `:root` and only completed when it
// landed on the element `:root` matches.
//
// What this suite measures is that alias itself: `--border`, the token the base
// layer's `* { border-color: var(--border) }` gives every border the app does
// not colour explicitly, RESOLVED against a real element chain inside the
// panel. In the island's dark document it stayed at the LIGHT hairline and was
// composited over a dark panel — the panel's ground and no outline at all —
// while the same chain on the run page resolved the dark hairline.
//
// The chain is read at the panel's own frame, `[data-conformance-id=
// \"review-target\"]`. That frame declares `border border-line`, so `--line`
// and not `--border` is what paints the frame's own pixels; the frame is used
// here as a STABLE POINT ON THE CHAIN, because cinatra#3141 item 7 moved the
// one element the base layer alone used to colour — the target chip — out of
// this document entirely. Both tokens are therefore checked: the alias, which
// is the bug class, and the frame's own `--line`, which is what it draws.
//
// jsdom implements no custom-property substitution, so this suite resolves the
// cascade from the stylesheet itself against the element chain the render
// produced — the class lists are the components' own, never a copy of them.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The mount and the pinned-capture pair are rendered, not exercised, here — each
// carries its own suite. Stubbed so this suite does not drag the renderer-
// resolution graph in behind the panel's markup.
vi.mock("@/app/artifacts/[id]/review-target-mount", () => ({
  ReviewTargetMount: () => null,
}));
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-pinned-capture",
  () => ({ ReviewPinnedCapture: () => null }),
);

import { ReviewTargetPanel } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel";

import { islandBodyClassName } from "../island-color-scheme";

// ---------------------------------------------------------------------------
// The stylesheet, read as the browser reads it: the three palette blocks and the
// one base-layer rule that colours every border.
// ---------------------------------------------------------------------------

const GLOBALS_CSS = readFileSync(
  join(process.cwd(), "src/app/globals.css"),
  "utf8",
);

type Decls = Map<string, string>;

/** Every top-level rule, by selector. Comments go first so a brace inside one
 *  cannot be read as structure. */
function topLevelRules(css: string): Array<{ selector: string; body: string }> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Array<{ selector: string; body: string }> = [];
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
      // An at-statement (`@import`, `@custom-variant`) — not a rule.
      selectorStart = i + 1;
    }
  }
  return rules;
}

const RULES = topLevelRules(GLOBALS_CSS);

function declarationsIn(body: string): Decls {
  const out: Decls = new Map();
  for (const part of body.split(";")) {
    const m = /^\s*(--[A-Za-z0-9-]+)\s*:\s*([\s\S]+)$/.exec(part);
    if (m) out.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
  }
  return out;
}

/** The declarations of every block with exactly this selector, in stylesheet
 *  order — the order the cascade reads them in, since `:root`, `.cinatra` and
 *  `.dark` all weigh the same. */
function paletteBlock(selector: string): Decls {
  const out: Decls = new Map();
  let seen = 0;
  for (const rule of RULES) {
    if (rule.selector !== selector) continue;
    seen += 1;
    for (const [name, value] of declarationsIn(rule.body)) out.set(name, value);
  }
  if (seen === 0) throw new Error(`no \`${selector}\` block in globals.css`);
  return out;
}

const ROOT_TOKENS = paletteBlock(":root");
const CINATRA_TOKENS = paletteBlock(".cinatra");
const DARK_TOKENS = paletteBlock(".dark");
const THEME_COLORS = paletteBlock("@theme inline");

/** The declaration that colours every border in the app — read out of the base
 *  layer rather than restated, so this suite measures what the page paints. */
const BASE_BORDER_COLOR = (() => {
  const base = RULES.find((r) => r.selector === "@layer base");
  if (!base) throw new Error("no base layer in globals.css");
  const universal = /(^|})\s*\*\s*\{([^}]*)\}/.exec(base.body);
  if (!universal) throw new Error("the base layer states no universal rule");
  const decl = /(^|;)\s*border-color\s*:\s*([^;]+)/.exec(universal[2]!);
  if (!decl) throw new Error("the universal rule sets no border-color");
  return decl[2]!.trim();
})();

// ---------------------------------------------------------------------------
// The cascade, resolved against a real element chain.
// ---------------------------------------------------------------------------

type Themed = {
  readonly classes: readonly string[];
  readonly isRoot: boolean;
  readonly parent: Themed | null;
};

/** The palette blocks that match one element, in stylesheet order. */
function blocksFor(el: Themed): Decls[] {
  const blocks: Decls[] = [];
  if (el.isRoot) blocks.push(ROOT_TOKENS);
  if (el.classes.includes("cinatra")) blocks.push(CINATRA_TOKENS);
  if (el.classes.includes("dark")) blocks.push(DARK_TOKENS);
  return blocks;
}

function declaredOn(el: Themed, name: string): string | undefined {
  const blocks = blocksFor(el);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const value = blocks[i]!.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** A custom property's COMPUTED value at one element: substituted where it is
 *  declared, inherited from the parent where it is not. */
function tokenAt(el: Themed, name: string): string | undefined {
  const raw = declaredOn(el, name);
  if (raw === undefined) return el.parent ? tokenAt(el.parent, name) : undefined;
  return substituteAt(el, raw);
}

function substituteAt(el: Themed, value: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = value.indexOf("var(", i);
    if (at === -1) {
      out += value.slice(i);
      return out.replace(/\s+/g, " ").trim();
    }
    out += value.slice(i, at);
    let depth = 1;
    let j = at + 4;
    while (depth > 0 && j < value.length) {
      const c = value[j];
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      j += 1;
    }
    const args = splitTopLevel(value.slice(at + 4, j - 1));
    const referenced = tokenAt(el, args[0]!.trim());
    const fallback = args.slice(1).join(",").trim();
    out +=
      referenced !== undefined
        ? referenced
        : fallback
          ? substituteAt(el, fallback)
          : `unresolved(${args[0]!.trim()})`;
    i = j;
  }
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of text) {
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  return parts;
}

/** The theme chain above one rendered element. */
function chainOf(element: Element): Themed {
  const ancestry: Element[] = [];
  for (let e: Element | null = element; e; e = e.parentElement) ancestry.push(e);
  let node: Themed | null = null;
  for (let i = ancestry.length - 1; i >= 0; i -= 1) {
    const e = ancestry[i]!;
    node = {
      classes: Array.from(e.classList),
      isRoot: e === document.documentElement,
      parent: node,
    };
  }
  return node!;
}

// ---------------------------------------------------------------------------
// Colour, in the units the picture is measured in.
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

function clamp255(x: number): number {
  return Math.max(0, Math.min(255, Math.round(x)));
}

function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const gamma = (x: number) =>
    x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return [
    clamp255(gamma(linear[0]!) * 255),
    clamp255(gamma(linear[1]!) * 255),
    clamp255(gamma(linear[2]!) * 255),
  ];
}

/** The three colour notations this palette is written in. */
function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgba) {
    const parts = rgba[1]!.split(",").map((p) => Number(p.trim()));
    return {
      rgb: [clamp255(parts[0]!), clamp255(parts[1]!), clamp255(parts[2]!)],
      alpha: parts.length > 3 ? parts[3]! : 1,
    };
  }
  const oklch = /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*([0-9.]+)(%?)\s*)?\)$/i.exec(
    value,
  );
  if (oklch) {
    const rawAlpha = oklch[4] === undefined ? 1 : Number(oklch[4]);
    return {
      rgb: oklchToRgb(Number(oklch[1]), Number(oklch[2]), Number(oklch[3])),
      alpha: oklch[5] === "%" ? rawAlpha / 100 : rawAlpha,
    };
  }
  throw new Error(`unreadable colour: ${value}`);
}

/** What the eye (and the screenshot) sees: `value` painted on `ground`. */
function paintedOn(value: string, ground: string): Rgb {
  const fg = parseColor(value);
  const bg = parseColor(ground);
  expect(bg.alpha, "a ground is opaque").toBe(1);
  return [0, 1, 2].map((i) =>
    clamp255(fg.alpha * fg.rgb[i]! + (1 - fg.alpha) * bg.rgb[i]!),
  ) as unknown as Rgb;
}

function channelDistance(a: Rgb, b: Rgb): number {
  return Math.max(...[0, 1, 2].map((i) => Math.abs(a[i]! - b[i]!)));
}

// ---------------------------------------------------------------------------
// The two documents, each with the REAL panel rendered inside it.
// ---------------------------------------------------------------------------

// cinatra#3141 item 7 moved the target chip and title into the CARD's own
// `ReviewTargetHeader` (packages/agents/src/review-gate-card.tsx), so this
// document no longer draws the one element the base layer alone coloured. The
// alias is therefore resolved at the panel's own frame instead — a different
// element, the SAME cascade question. The frame's own `border-line` is pinned
// alongside it so the element's actual paint is not left unasserted.

/** One pinned target, shaped like the gate the picture was taken of. */
const PREPARED = {
  target: {
    artifactId: "artifact-1",
    representationRevisionId: "rev-000000000000001",
  },
  props: {
    artifact: {
      title: "Launch announcement",
      objectType: "@cinatra-ai/blog-post-artifact",
      ownerLevel: "Team",
      visibility: "Private",
      mime: "text/html",
      updatedAt: "8 min ago",
    },
  },
  // cinatra#3141 item 7 / §V: only the floor kind still draws a provenance
  // region (Floor pill + muted-foreground reading) — build-map and runtime
  // draw none, so the floor kind is what keeps this suite exercising the
  // "--muted-foreground" token the region paints with.
  mount: {
    kind: "floor",
    slot: "review",
    packageName: "@cinatra-ai/blog-post-artifact",
  },
} as unknown as Parameters<typeof ReviewTargetPanel>[0]["prepared"];

const PANEL_MARKUP = renderToStaticMarkup(
  <ReviewTargetPanel prepared={PREPARED} orgId="org-1" capturePair={null} />,
);

/**
 * THE RUN PAGE, dark. The theme control writes the palette class onto the
 * document ROOT (`attribute="class"`, one of `cinatra` / `dark`), and nothing
 * between that root and the panel names a palette.
 *
 * Each host is entered through a callback because the two share one document:
 * whatever is read off the panel has to be read while that panel is the one
 * mounted.
 */
function onRunPage<T>(read: (at: Element) => T): T {
  return mounted("dark", (host) => {
    host.innerHTML = PANEL_MARKUP;
  }, read);
}

/**
 * THE ISLAND, dark. The frame's own theme store is partitioned away from the
 * app's, so nothing ever wrote it and the document root falls back to the app's
 * DEFAULT palette; the host's palette arrives on the wrapper the island draws
 * the ladder in.
 */
function inIsland<T>(read: (at: Element) => T): T {
  return mounted("cinatra", (host) => {
    const wrapper = document.createElement("div");
    wrapper.className = islandBodyClassName("dark");
    wrapper.innerHTML = PANEL_MARKUP;
    host.append(wrapper);
  }, read);
}

function mounted<T>(
  rootClass: string,
  fill: (host: HTMLElement) => void,
  read: (at: Element) => T,
): T {
  document.documentElement.className = rootClass;
  document.body.className = "";
  document.body.innerHTML = "";
  fill(document.body);
  // The panel's own frame. The fixture renders exactly one target, so this is
  // the single `review-target` element in the document.
  const frames = document.body.querySelectorAll(
    "[data-conformance-id='review-target']",
  );
  expect(frames.length, "the fixture renders exactly one target panel").toBe(1);
  return read(frames[0]!);
}

/** The base layer's `border-color` alias, RESOLVED on this element's chain.
 *  Not a claim about what this element paints — a reading of the alias the
 *  island's palette wrapper used to leave unfinished. */
function baseBorderAt(at: Element): string {
  return substituteAt(chainOf(at), BASE_BORDER_COLOR);
}

/** The token the frame's own `border-line` utility paints its border with. */
function declaredBorderAt(at: Element): string {
  const line = tokenAt(chainOf(at), "--line");
  expect(line, "the frame's own border token resolves").toBeTruthy();
  return line!;
}

/** The ground it is painted on — the panel's own `bg-surface-strong`. */
function groundAt(at: Element): string {
  const ground = tokenAt(chainOf(at), "--surface-strong");
  expect(ground, "the panel's ground resolves").toBeTruthy();
  return ground!;
}

describe("the panel keeps its hairline inside the island's dark document", () => {
  it("draws the outline the run page draws, not the ground it sits on", () => {
    const run = onRunPage((at) => ({
      outline: baseBorderAt(at),
      ground: groundAt(at),
    }));
    const island = inIsland((at) => ({
      outline: baseBorderAt(at),
      ground: groundAt(at),
    }));

    // The same hairline token, so the same pixels.
    expect(island.outline).toBe(run.outline);
    expect(paintedOn(island.outline, island.ground)).toEqual(
      paintedOn(run.outline, run.ground),
    );

    // And an outline that is visible AS an outline: a hairline the panel's own
    // ground swallows is not one.
    expect(
      channelDistance(
        paintedOn(island.outline, island.ground),
        parseColor(island.ground).rgb,
      ),
    ).toBeGreaterThan(8);
  });

  // The alias above is the bug class. This is the element's OWN paint: the
  // frame declares `border-line`, and that token has to land identically in
  // both documents too, or the frame diverges even while the alias agrees.
  it("draws the hairline it actually declares the same in both documents", () => {
    const run = onRunPage(declaredBorderAt);
    const island = inIsland(declaredBorderAt);
    expect(island).toBe(run);
    expect(
      channelDistance(
        paintedOn(island, inIsland(groundAt)),
        parseColor(inIsland(groundAt)).rgb,
      ),
    ).toBeGreaterThan(8);
  });

  it("keeps the run page exactly where it was — the dark hairline over the panel", () => {
    const run = onRunPage((at) => ({
      outline: baseBorderAt(at),
      ground: groundAt(at),
    }));
    expect(run.outline).toBe("oklch(1 0 0 / 10%)");
    expect(paintedOn(run.outline, run.ground)).toEqual([37, 47, 63]);
  });
});

describe("every token the panel paints with reads the same on both hosts", () => {
  it("resolves identically in the island's dark document and on the run page", () => {
    const PREFIXES = [
      "bg",
      "text",
      "border",
      "ring",
      "outline",
      "divide",
      "fill",
      "stroke",
      "from",
      "via",
      "to",
      "shadow",
      "decoration",
      "accent",
      "caret",
    ];

    /** The token the base layer colours every unclaimed border with. */
    const baseBorderMatch = /var\(\s*(--[A-Za-z0-9-]+)\s*\)/.exec(BASE_BORDER_COLOR);
    if (!baseBorderMatch) throw new Error("the border colour is not a token");
    const baseBorderToken = baseBorderMatch[1]!;

    /** Every token the rendered panel asks for, resolved WHERE it asks for it —
     *  walking the markup's own class lists through the theme's colour
     *  bindings, so the enumeration is the panel's and not a copy of it. */
    function tokensUnder(at: Element): Map<string, string | undefined> {
      const panel = at.closest("[data-conformance-id='review-target']");
      if (!panel) throw new Error("the anchor is not inside a target panel");
      const resolved = new Map<string, string | undefined>();
      const note = (token: string, at: Element) => {
        if (!resolved.has(token)) resolved.set(token, tokenAt(chainOf(at), token));
      };
      for (const el of [panel, ...Array.from(panel.querySelectorAll("*"))]) {
        for (const cls of Array.from(el.classList)) {
          const utility = cls.split("/")[0]!;
          for (const prefix of PREFIXES) {
            if (!utility.startsWith(`${prefix}-`)) continue;
            const binding = THEME_COLORS.get(
              `--color-${utility.slice(prefix.length + 1)}`,
            );
            if (!binding) continue;
            const referenced = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(binding);
            if (referenced) note(referenced[1]!, el);
          }
        }
      }
      note(baseBorderToken, at);
      return resolved;
    }

    const run = onRunPage(tokensUnder);
    const island = inIsland(tokensUnder);

    // The enumeration is the panel's own, so it must not quietly become empty.
    expect(Array.from(island.keys()).sort()).toEqual(Array.from(run.keys()).sort());
    // `--foreground` is NOT on this list any more (cinatra#3141 item 7): the
    // target's own header — its title, its type chip and its pinned revision —
    // is drawn by the CARD now, not inside this document, because the header
    // has to survive the states in which this document has not painted at all.
    // What the island still paints is the provenance reading and the
    // representation, and those are the tokens enumerated here.
    for (const name of [
      "--surface-strong",
      "--line",
      "--muted-foreground",
      "--border",
    ]) {
      expect(Array.from(run.keys())).toContain(name);
    }

    const divergent: Array<{ token: string; runPage?: string; island?: string }> = [];
    for (const [name, onRunPageValue] of run) {
      const inIslandValue = island.get(name);
      if (onRunPageValue !== inIslandValue) {
        divergent.push({ token: name, runPage: onRunPageValue, island: inIslandValue });
      }
    }
    expect(divergent).toEqual([]);
  });
});

describe("the dark palette is closed, so it cannot reopen one alias at a time", () => {
  it("re-declares every alias whose token it overrides", () => {
    const unclosed: string[] = [];
    for (const [name, value] of ROOT_TOKENS) {
      if (DARK_TOKENS.has(name)) continue;
      const referenced = Array.from(value.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)).map(
        (m) => m[1]!,
      );
      if (referenced.some((token) => DARK_TOKENS.has(token))) unclosed.push(name);
    }
    expect(unclosed).toEqual([]);
  });

  it("changes nothing on the document root — each alias is the one it completes", () => {
    // The palette on the document root, resolved: the values the app has always
    // computed there, alias layer completed or not.
    const root: Themed = { classes: ["dark"], isRoot: true, parent: null };
    expect(tokenAt(root, "--border")).toBe("oklch(1 0 0 / 10%)");
    expect(tokenAt(root, "--card")).toBe("oklch(0.165 0.04 259)");
    expect(tokenAt(root, "--card-foreground")).toBe("oklch(0.984 0.003 247.858)");
    expect(tokenAt(root, "--popover")).toBe("oklch(0.21 0.04 259)");
    expect(tokenAt(root, "--popover-foreground")).toBe("oklch(0.984 0.003 247.858)");
    // cinatra#3192 fix leg 2: `--primary` resolves through `--accent`, which
    // the dark ramp now draws as the one indigo rule 2 names rather than the
    // stock shadcn slate; `--ring` resolves through its ink end.
    expect(tokenAt(root, "--primary")).toBe("#364e81");
    expect(tokenAt(root, "--secondary")).toBe("oklch(0.279 0.041 260.031)");
    expect(tokenAt(root, "--muted-foreground")).toBe("oklch(0.704 0.04 256.788)");
    expect(tokenAt(root, "--ring")).toBe("oklch(0.78 0.09 268)");
  });
});
