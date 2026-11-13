// @vitest-environment jsdom
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";

import { contrastAgainst } from "@/lib/color-contrast";

// The generator's own CSS walker (strings, escapes and nesting aware) reads the
// stylesheets here, so the tests and the scoped copy agree on what a rule is.
import { parseItems, splitSelectorList } from "../../../sdk-dashboard/scripts/scope-drizzle-cube-styles.mjs";

/**
 * Contract: a KPI value drawn by drizzle-cube follows the application's
 * foreground token where, and only where, drizzle-cube fell back to its own
 * colour (cinatra#4311).
 *
 * drizzle-cube's KPI charts (kpiNumber, kpiText) paint their value with an
 * INLINE colour: the first colour of the palette the provider is given, or,
 * when that palette has no colours, the literal `#1f2937`, which stays a very
 * dark grey on the near-black ground of the dark palette.
 *
 * Provenance comes from the host: a host that mounts the provider with no
 * palette colour marks the grid with `data-cinatra-kpi-fallback="foreground"`,
 * and the rule in `dashboard-theme.css` repaints only under that marker. The
 * hosts are covered in components/__tests__/kpi-value-fallback-hosts.test.tsx.
 *
 * This file pins the rule BY BEHAVIOUR: the rule's real selector is run with
 * `Element.matches` against KPI value elements carrying the exact style strings
 * a browser (client-side write) and React server markup produce, inside and
 * outside the marker, and against the false positives a substring match would
 * have caught. It also resolves the foreground token in both palettes, and pins
 * the drizzle-cube internals the rule depends on against the installed bundle.
 */

const SDK_COMPONENTS = join(__dirname, "..", "..", "..", "sdk-dashboard", "src", "components");
const THEME_CSS = readFileSync(join(SDK_COMPONENTS, "dashboard-theme.css"), "utf-8");
const GLOBALS_CSS = readFileSync(
  join(__dirname, "..", "..", "..", "..", "src", "app", "globals.css"),
  "utf-8",
);

type Block = { prelude: string; body: string };

function topLevelBlocks(css: string): Block[] {
  return (parseItems(css) as Array<{ kind: string; prelude?: string; body?: string }>)
    .filter((item) => item.kind === "block")
    .map((item) => ({ prelude: item.prelude ?? "", body: item.body ?? "" }));
}

const themeRules = topLevelBlocks(THEME_CSS);
const kpiRules = themeRules.filter((r) => r.prelude.includes("data-cinatra-kpi-fallback"));
const KPI_SELECTOR = kpiRules[0]?.prelude ?? "";

/** The style strings drizzle-cube's KPI value carries, as each road serialises them. */
const CLIENT_FALLBACK = "font-size: 48px; color: rgb(31, 41, 55);";
const SERVER_FALLBACK = "font-size:48px;color:#1f2937";
const NUMBER_HOOK = "dc:font-bold dc:leading-none";
const TEXT_HOOK = "dc:font-bold dc:leading-tight dc:text-center";

/**
 * Build `<ancestors...><div class=hook style=style>` and return the value
 * element. Each ancestor is a set of attributes.
 */
function kpiValue(
  hook: string,
  style: string,
  ancestors: Array<Record<string, string>> = [{ "data-cinatra-kpi-fallback": "foreground" }],
): Element {
  let parent: Element = document.body;
  for (const attrs of ancestors) {
    const el = document.createElement("div");
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    parent.appendChild(el);
    parent = el;
  }
  const value = document.createElement("div");
  value.setAttribute("class", hook);
  value.setAttribute("style", style);
  parent.appendChild(value);
  return value;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("dashboard-theme.css: the KPI fallback rule", () => {
  it("is exactly one rule, and no other theme rule targets the KPI value hook", () => {
    expect(kpiRules).toHaveLength(1);
    expect(themeRules.filter((r) => r.prelude.includes(".dc\\:font-bold"))).toHaveLength(1);
  });

  it("declares only the foreground token, with the priority an inline colour needs", () => {
    const body = (kpiRules[0]?.body ?? "").replace(/\s+/g, " ").trim();
    expect(body).toMatch(/^color: var\(--foreground\) !important;?$/);
  });

  it("every alternative of its selector list is scoped to the marker", () => {
    const alternatives = splitSelectorList(KPI_SELECTOR) as string[];
    expect(alternatives.length).toBeGreaterThan(0);
    for (const alternative of alternatives) {
      expect(alternative.startsWith('[data-cinatra-kpi-fallback="foreground"] ')).toBe(true);
    }
  });

  it.each([
    ["kpiNumber, client-side write", NUMBER_HOOK, CLIENT_FALLBACK],
    ["kpiNumber, server markup", NUMBER_HOOK, SERVER_FALLBACK],
    ["kpiText, client-side write", TEXT_HOOK, CLIENT_FALLBACK],
    ["kpiText, server markup", TEXT_HOOK, SERVER_FALLBACK],
  ])("repaints the fallback under the marker: %s", (_name, hook, style) => {
    expect(kpiValue(hook, style).matches(KPI_SELECTOR)).toBe(true);
  });

  it.each([
    ["the marker alone", [{ "data-cinatra-kpi-fallback": "foreground" }]],
    [
      "the marker inside the read-only composition only",
      [{ "data-cinatra-read-only-composition": "dashboard" }, { "data-cinatra-kpi-fallback": "foreground" }],
    ],
    [
      "the marker inside the dashboards shell only",
      [{ "data-cinatra-dashboard-shell": "true" }, { "data-cinatra-kpi-fallback": "foreground" }],
    ],
    [
      "the marker on the composition element itself",
      [{ "data-cinatra-read-only-composition": "single-portlet", "data-cinatra-kpi-fallback": "foreground" }],
    ],
  ])("matches under %s (no second ancestor is required)", (_name, ancestors) => {
    expect(kpiValue(NUMBER_HOOK, CLIENT_FALLBACK, ancestors).matches(KPI_SELECTOR)).toBe(true);
  });

  it.each([
    ["no ancestor at all", []],
    ["the dashboards shell without the marker", [{ "data-cinatra-dashboard-shell": "true" }]],
    ["the read-only composition without the marker", [{ "data-cinatra-read-only-composition": "dashboard" }]],
    ["a marker with another value", [{ "data-cinatra-kpi-fallback": "" }]],
  ])("does not match under %s", (_name, ancestors) => {
    expect(kpiValue(NUMBER_HOOK, CLIENT_FALLBACK, ancestors).matches(KPI_SELECTOR)).toBe(false);
    expect(kpiValue(TEXT_HOOK, SERVER_FALLBACK, ancestors).matches(KPI_SELECTOR)).toBe(false);
  });

  it.each([
    ["a palette colour", NUMBER_HOOK, "font-size: 48px; color: rgb(59, 130, 246);"],
    ["a longer colour, client-side", NUMBER_HOOK, "font-size: 48px; color: rgba(31, 41, 55, 0.667);"],
    ["a longer colour, server markup", NUMBER_HOOK, "font-size:48px;color:#1f2937aa"],
    [
      "the value on another property, client-side",
      NUMBER_HOOK,
      "font-size: 48px; color: rgb(225, 29, 72); box-shadow: rgb(31, 41, 55) 0px 0px 0px 0px;",
    ],
    ["the value on another property, server markup", NUMBER_HOOK, "color:#e11d48;box-shadow:0 0 0 #1f2937"],
    ["a border-color, client-side", NUMBER_HOOK, "font-size: 48px; border-color: rgb(31, 41, 55);"],
    ["a border-color, server markup", NUMBER_HOOK, "font-size:48px;border-color:#1f2937"],
    ["the no-data reading (no inline colour)", `${NUMBER_HOOK} text-dc-text-muted`, "font-size: 48px;"],
    ["a tooltip (no KPI hook)", "", "color: rgb(31, 41, 55);"],
    ["another bold element (one hook class only)", "dc:font-bold", CLIENT_FALLBACK],
  ])("leaves %s alone, even under the marker", (_name, hook, style) => {
    expect(kpiValue(hook, style).matches(KPI_SELECTOR)).toBe(false);
  });
});

describe("the foreground token reads in both palettes", () => {
  /** Custom properties of the first block whose prelude is exactly `selector`. */
  function tokens(selector: string): Map<string, string> {
    const block = topLevelBlocks(GLOBALS_CSS).find((b) => b.prelude === selector);
    expect(block, `src/app/globals.css has no \`${selector}\` block`).toBeTruthy();
    const map = new Map<string, string>();
    for (const item of parseItems(`${block!.body};`) as Array<{ kind: string; text?: string }>) {
      if (item.kind !== "statement" || !item.text) continue;
      const colon = item.text.indexOf(":");
      const name = item.text.slice(0, colon).trim();
      if (name.startsWith("--")) map.set(name, item.text.slice(colon + 1).replace(/;$/, "").trim());
    }
    return map;
  }

  const light = tokens(":root");
  const dark = new Map([...light, ...tokens(".dark")]);

  function resolve(map: Map<string, string>, value: string, depth = 0): string {
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    if (!ref || depth > 8) return value;
    const next = map.get(ref[1]);
    expect(next, `${ref[1]} is not defined`).toBeTruthy();
    return resolve(map, next!, depth + 1);
  }

  // The KPI value sits on the portlet card (`--dc-card-bg: var(--card)`).
  it.each([
    ["light", light],
    ["dark", dark],
  ])("%s: the foreground token is legible text on the card ground", (_name, map) => {
    const ink = resolve(map, "var(--foreground)");
    const ground = resolve(map, "var(--card)");
    expect(contrastAgainst(ink, ground)).toBeGreaterThanOrEqual(4.5);
  });

  it("dark: drizzle-cube's fallback is not legible on the card ground (the defect this rule repairs)", () => {
    expect(contrastAgainst("#1f2937", resolve(dark, "var(--card)"))).toBeLessThan(3);
  });
});

// pnpm symlinks the dep under the package's own node_modules; realpath
// through to the store so readdir works on the actual dist tree.
const DC_ROOT = realpathSync(join(__dirname, "..", "..", "node_modules", "drizzle-cube"));
const CHUNKS = join(DC_ROOT, "dist", "client", "chunks");

/**
 * Every source file of the installed client bundle, by base name, read from
 * the chunk sourcemaps. Scanned across ALL chunks because the chunk a helper
 * lands in is a bundler decision (KpiNumber.helpers.ts ships in the kpiDelta
 * chunk, which both KPI charts share).
 */
function bundleSources(): Map<string, string> {
  const byName = new Map<string, string>();
  for (const file of readdirSync(CHUNKS)) {
    if (!file.endsWith(".js.map")) continue;
    const map = JSON.parse(readFileSync(join(CHUNKS, file), "utf-8")) as {
      sources: string[];
      sourcesContent?: Array<string | null>;
    };
    map.sources.forEach((source, i) => {
      const name = source.split("/").pop()!;
      const content = map.sourcesContent?.[i];
      if (content && !byName.has(name)) byName.set(name, content);
    });
  }
  return byName;
}

describe("drizzle-cube internals the KPI fallback rule depends on", () => {
  const sources = bundleSources();
  const get = (name: string): string => {
    const content = sources.get(name);
    expect(
      content,
      `${name} missing from the drizzle-cube bundle sourcemaps — re-verify the KPI value contract`,
    ).toBeTruthy();
    return content!;
  };

  it("kpiNumber falls back to #1f2937 when the palette has no colours", () => {
    expect(get("KpiNumber.helpers.ts")).toContain("return colors?.[0] || '#1f2937'");
  });

  it("kpiNumber paints its value inline on its hook, font size first and colour last", () => {
    expect(get("KpiNumber.tsx")).toMatch(
      /className="dc:font-bold dc:leading-none"\s*style=\{\{\s*fontSize: `\$\{fontSize\}px`,\s*color: valueColor\s*\}\}/,
    );
  });

  it("kpiText falls back to #1f2937 and paints its value inline the same way", () => {
    expect(get("kpiTextHelpers.ts")).toContain("return colorPalette?.colors?.[0] || '#1f2937'");
    expect(get("KpiText.tsx")).toMatch(
      /className="dc:font-bold dc:leading-tight dc:text-center"\s*style=\{\{\s*fontSize: `\$\{fontSize\}px`,\s*color: valueColor\s*\}\}/,
    );
  });

  it("a chart's palette comes only from the provider's colorPalette prop", () => {
    // The marker's provenance argument: drizzle-cube never derives a palette
    // from the dashboard configuration on the dashboard road, so a host that
    // passes none leaves every KPI value on the fallback.
    expect(get("DashboardCoordinator.tsx")).not.toMatch(/getColorPalette/);
  });
});
