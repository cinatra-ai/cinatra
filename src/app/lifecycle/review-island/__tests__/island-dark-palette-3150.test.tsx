// @vitest-environment jsdom
//
// cinatra#3150 — A JSON-TYPED PINNED TARGET NEVER DRAWS A BLANK PANEL, in the
// light AND the dark palette.
//
// Acceptance, verbatim: "A review gate pinned on a JSON-typed artifact, opened
// in the dark theme, draws the document (the collapsible JSON tree) or one of
// the renderer's own named floor sentences — never a visually blank region."
// and "a light-theme case is added alongside so a future regression in either
// palette is caught."
//
// WHAT "VISUALLY BLANK" MEANS AT THIS TIER. jsdom paints nothing, so the test
// reads the two things a blank panel is made of: (1) no drawn element at all —
// neither the JSON tree nor a named floor — and (2) a drawn element whose ink
// resolves, through the island's own palette chain, to (nearly) the colour of
// the ground it sits on. The palette is resolved from `src/app/globals.css`
// itself against the element chain the render produced, exactly as the
// neighbouring island-dark-palette suite resolves it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { FunctionComponent } from "react";

import { loadArtifactRenderer } from "@/lib/artifacts/artifact-renderer-loader";
import { ARTIFACT_RENDERER_PROPS_API_VERSION, type ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";

import { islandBodyClassName, type IslandColorScheme } from "../island-color-scheme";

// The JSON pack's detail display, reached through the generated renderer map
// (the loader), the road core takes to every extension display.
const loadedJsonDetail = await loadArtifactRenderer({
  generatedKey: "@cinatra-ai/json-artifact::detail",
  packageName: "@cinatra-ai/json-artifact",
  slot: "detail",
  expectedPropsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION,
});
if (!loadedJsonDetail.ok) throw new Error(`the JSON display did not load: ${loadedJsonDetail.failureClass}`);
const JsonArtifactDetail = loadedJsonDetail.Component as FunctionComponent<ArtifactRendererProps>;

const GLOBALS_CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

type Decls = Map<string, string>;

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

function paletteBlock(selector: string): Decls {
  const out: Decls = new Map();
  for (const rule of RULES) {
    if (rule.selector !== selector) continue;
    for (const part of rule.body.split(";")) {
      const m = /^\s*(--[A-Za-z0-9-]+)\s*:\s*([\s\S]+)$/.exec(part);
      if (m) out.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
    }
  }
  if (out.size === 0) throw new Error(`no \`${selector}\` block in globals.css`);
  return out;
}

const ROOT_TOKENS = paletteBlock(":root");
const CINATRA_TOKENS = paletteBlock(".cinatra");
const DARK_TOKENS = paletteBlock(".dark");

type Themed = { classes: readonly string[]; isRoot: boolean; parent: Themed | null };

function declaredOn(el: Themed, name: string): string | undefined {
  const blocks: Decls[] = [];
  if (el.isRoot) blocks.push(ROOT_TOKENS);
  if (el.classes.includes("cinatra")) blocks.push(CINATRA_TOKENS);
  if (el.classes.includes("dark")) blocks.push(DARK_TOKENS);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const v = blocks[i]!.get(name);
    if (v !== undefined) return v;
  }
  return undefined;
}

function tokenAt(el: Themed, name: string): string | undefined {
  const raw = declaredOn(el, name);
  if (raw === undefined) return el.parent ? tokenAt(el.parent, name) : undefined;
  return substituteAt(el, raw);
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

function substituteAt(el: Themed, value: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = value.indexOf("var(", i);
    if (at === -1) return (out + value.slice(i)).replace(/\s+/g, " ").trim();
    out += value.slice(i, at);
    let depth = 1;
    let j = at + 4;
    while (depth > 0 && j < value.length) {
      if (value[j] === "(") depth += 1;
      else if (value[j] === ")") depth -= 1;
      j += 1;
    }
    const args = splitTopLevel(value.slice(at + 4, j - 1));
    const referenced = tokenAt(el, args[0]!.trim());
    const fallback = args.slice(1).join(",").trim();
    out += referenced !== undefined ? referenced : fallback ? substituteAt(el, fallback) : "inherit";
    i = j;
  }
}

function chainOf(element: Element): Themed {
  const ancestry: Element[] = [];
  for (let e: Element | null = element; e; e = e.parentElement) ancestry.push(e);
  let node: Themed | null = null;
  for (let i = ancestry.length - 1; i >= 0; i -= 1) {
    const e = ancestry[i]!;
    node = { classes: Array.from(e.classList), isRoot: e === document.documentElement, parent: node };
  }
  return node!;
}

type Rgb = readonly [number, number, number];
const clamp255 = (x: number) => Math.max(0, Math.min(255, Math.round(x)));

function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const g = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  return [clamp255(g(lin[0]!) * 255), clamp255(g(lin[1]!) * 255), clamp255(g(lin[2]!) * 255)];
}

function parseColor(value: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const oklch = /^oklch\(\s*([0-9.]+)%?\s+([0-9.]+)\s+([0-9.]+)\s*\)$/i.exec(value);
  if (oklch) {
    const L = Number(oklch[1]);
    return oklchToRgb(L > 1 ? L / 100 : L, Number(oklch[2]), Number(oklch[3]));
  }
  throw new Error(`unreadable colour: ${value}`);
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// ---------------------------------------------------------------------------
// The panel as the island draws it: the island body in the host's palette, the
// target panel's own ground, and the JSON display mounted in the slot.
// ---------------------------------------------------------------------------

const REVISION = "rev-3150";
const DOCUMENT = JSON.stringify({ title: "Quarterly summary", count: 3, done: false, notes: null });

function jsonProps(content: unknown) {
  return {
    propsApiVersion: 2,
    artifact: {
      id: "artifact-3150",
      title: "Run output",
      objectType: "@cinatra-ai/json-artifact:artifact",
      mime: "application/json",
      size: DOCUMENT.length,
      createdAt: "",
      updatedAt: "",
      ownerLevel: "organization",
      visibility: "organization",
      sourceUrl: null,
    },
    representation: { revisionId: REVISION, mime: "application/json" },
    content,
  } as unknown as Parameters<typeof JsonArtifactDetail>[0];
}

const TEXT_CONTENT = {
  kind: "text",
  channelVersion: 1,
  representationRevisionId: REVISION,
  text: DOCUMENT,
  encoding: "utf-8",
  byteLength: DOCUMENT.length,
  projectedByteLength: DOCUMENT.length,
  cap: 262144,
  truncated: false,
};
const ABSENT_CONTENT = { kind: "none", channelVersion: 1, representationRevisionId: REVISION, reason: "absent" };

function mountInIsland(scheme: IslandColorScheme, content: unknown): HTMLElement {
  // The frame's own document root keeps the app's DEFAULT palette; the host's
  // palette arrives on the island body, as `page.tsx` draws it.
  document.documentElement.className = "cinatra";
  document.body.className = "";
  document.body.innerHTML = "";
  const body = document.createElement("div");
  body.className = islandBodyClassName(scheme);
  body.innerHTML =
    `<div data-conformance-id="review-target" class="rounded-control border border-line bg-surface-strong">` +
    `<div class="min-w-0 overflow-x-auto p-4" data-review-representation-slot="">` +
    renderToStaticMarkup(<JsonArtifactDetail {...jsonProps(content)} />) +
    `</div></div>`;
  document.body.append(body);
  return document.querySelector("[data-review-representation-slot]") as HTMLElement;
}

/** The ink every drawn run of text resolves to, on the panel's own ground. */
function inkReadings(slot: HTMLElement): Array<{ text: string; ink: string; ground: string; ratio: number }> {
  const ground = tokenAt(chainOf(slot), "--surface-strong");
  expect(ground, "the panel's ground resolves").toBeTruthy();
  const out: Array<{ text: string; ink: string; ground: string; ratio: number }> = [];
  for (const el of Array.from(slot.querySelectorAll<HTMLElement>("*"))) {
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
    if (!own) continue;
    // The nearest declared colour on the element chain, inside the panel.
    let colour: string | null = null;
    let at: HTMLElement | null = el;
    while (at && colour === null) {
      const m = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(at.getAttribute("style") ?? "");
      if (m) colour = m[1]!.trim();
      else if (at.classList.contains("text-foreground")) colour = "var(--foreground)";
      at = at.parentElement;
    }
    const ink = substituteAt(chainOf(el), colour ?? "var(--foreground)");
    out.push({ text: (el.textContent ?? "").trim(), ink, ground: ground!, ratio: contrast(parseColor(ink), parseColor(ground!)) });
  }
  return out;
}

afterEach(() => {
  document.documentElement.className = "";
  document.body.className = "";
  document.body.innerHTML = "";
});

// "The drawn text does not take the panel's own ground as its ink": below this
// ratio a run of text is indistinguishable from the ground it sits on.
const MIN_READABLE_RATIO = 1.5;

describe.each<[string, IslandColorScheme]>([
  ["R1D — the dark palette", "dark"],
  ["R1L — the light palette", "light"],
])("cinatra#3150 %s: a JSON-typed pinned target draws its document or a named floor, never a blank", (_label, scheme) => {
  it("draws the collapsible JSON tree for a pinned revision that holds a document, in ink the panel's ground does not swallow", () => {
    const slot = mountInIsland(scheme, TEXT_CONTENT);
    const drawn = slot.querySelector("[data-json-tree]") ?? slot.querySelector("[data-json-detail-floor]");
    expect(drawn, "the JSON tree or a named floor element is present").not.toBeNull();
    const readings = inkReadings(slot);
    console.info(`[3150 ${scheme}] ink readings`, JSON.stringify(readings.map((r) => [r.text.slice(0, 24), r.ink, r.ratio.toFixed(2)])));
    expect(readings.length, "the panel draws text").toBeGreaterThan(0);
    const blank = readings.filter((r) => r.ratio < MIN_READABLE_RATIO);
    expect(blank).toEqual([]);
  });

  it("draws the renderer's own named floor sentence when the revision carries no content, in readable ink", () => {
    const slot = mountInIsland(scheme, ABSENT_CONTENT);
    const drawn = slot.querySelector("[data-json-tree]") ?? slot.querySelector("[data-json-detail-floor]");
    expect(drawn, "the JSON tree or a named floor element is present").not.toBeNull();
    const readings = inkReadings(slot);
    expect(readings.length).toBeGreaterThan(0);
    expect(readings.filter((r) => r.ratio < MIN_READABLE_RATIO)).toEqual([]);
  });
});
