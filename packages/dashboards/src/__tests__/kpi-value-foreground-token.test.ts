import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Contract: a KPI value drawn by drizzle-cube follows the application's
 * foreground token in BOTH palettes (cinatra#4311).
 *
 * drizzle-cube's KPI charts (kpiNumber, kpiText) paint their value with an
 * INLINE colour: the dashboard colour palette's first colour, or, when the
 * dashboard carries no palette, the literal `#1f2937`. Neither the host
 * dashboards nor the shared read-only composition pass a palette, so the
 * value is always that literal: dark ink on the light ground, and a very dark
 * grey on the near-black ground of the dark palette, where it is not legible.
 *
 * An inline literal cannot be re-pointed with a `--dc-*` variable, so the
 * remedy is one unlayered rule in `dashboard-theme.css` (which the shared
 * read-only composition loads itself, so it reaches both the dashboard home
 * and an artifact page that mounts the composition) that repaints exactly
 * that fallback with `var(--foreground)`. A palette colour a dashboard does
 * choose is not the literal and is left alone. The latest drizzle-cube
 * release still carries the literal, so no upgrade removes the need.
 *
 * This test pins both halves:
 *   1. The rule in dashboard-theme.css: scoped to the dashboard surfaces, matching
 *      the KPI value hook and BOTH serialisations of the literal (server
 *      markup keeps `#1f2937`; a client-side style write serialises it as
 *      `rgb(31, 41, 55)`), declaring `color: var(--foreground) !important`.
 *   2. The drizzle-cube internals the rule depends on, read from the
 *      INSTALLED bundle's sourcemaps, so a version bump that changes the
 *      fallback or the value hook fails here instead of going silently dark.
 */

const THEME_CSS = readFileSync(
  join(__dirname, "..", "..", "..", "sdk-dashboard", "src", "components", "dashboard-theme.css"),
  "utf-8",
);

/** Top-level `selector { body }` rules of a stylesheet, comments removed. */
function topLevelRules(css: string): Array<{ selector: string; body: string }> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Array<{ selector: string; body: string }> = [];
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) {
        selector = text.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        rules.push({ selector, body: text.slice(start, i) });
        start = i + 1;
      }
    }
  }
  return rules;
}

const KPI_VALUE_HOOK = ".dc\\:font-bold";

const kpiRules = topLevelRules(THEME_CSS).filter((r) =>
  r.selector.includes(KPI_VALUE_HOOK),
);

describe("dashboard-theme.css repaints the drizzle-cube KPI value fallback with the foreground token (#4311)", () => {
  it("has exactly one rule on the KPI value hook", () => {
    expect(kpiRules, "no rule in dashboard-theme.css targets `.dc\\:font-bold`").toHaveLength(1);
  });

  it("is scoped to the read-only composition and the dashboard shell", () => {
    const selector = kpiRules[0]?.selector ?? "";
    expect(selector).toContain("[data-cinatra-read-only-composition]");
    expect(selector).toContain("[data-cinatra-dashboard-shell]");
  });

  it("matches the fallback literal in both serialisations", () => {
    const selector = kpiRules[0]?.selector ?? "";
    expect(selector).toMatch(/\[style\*="#1f2937"\s+i\]/);
    expect(selector).toContain('[style*="rgb(31, 41, 55)"]');
  });

  it("draws the value in the foreground token, never a literal colour", () => {
    const body = (kpiRules[0]?.body ?? "").replace(/\s+/g, " ").trim();
    expect(body).toMatch(/^color: var\(--foreground\) !important;?$/);
  });
});

// pnpm symlinks the dep under the package's own node_modules; realpath
// through to the store so readdir works on the actual dist tree.
const DC_ROOT = realpathSync(
  join(__dirname, "..", "..", "node_modules", "drizzle-cube"),
);
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

describe("drizzle-cube internals the KPI value rule depends on", () => {
  const sources = bundleSources();
  const get = (name: string): string => {
    const content = sources.get(name);
    expect(
      content,
      `${name} missing from the drizzle-cube bundle sourcemaps — re-verify the KPI value contract`,
    ).toBeTruthy();
    return content!;
  };

  it("kpiNumber falls back to #1f2937 when no palette is given", () => {
    expect(get("KpiNumber.helpers.ts")).toContain("return colors?.[0] || '#1f2937'");
  });

  it("kpiNumber paints its value inline on the `dc:font-bold` hook", () => {
    const src = get("KpiNumber.tsx");
    expect(src).toMatch(
      /className="dc:font-bold dc:leading-none"\s*style=\{\{\s*fontSize: `\$\{fontSize\}px`,\s*color: valueColor/,
    );
  });

  it("kpiText falls back to #1f2937 and paints its value inline on the same hook", () => {
    expect(get("kpiTextHelpers.ts")).toContain("return colorPalette?.colors?.[0] || '#1f2937'");
    expect(get("KpiText.tsx")).toMatch(
      /className="dc:font-bold dc:leading-tight dc:text-center"\s*style=\{\{\s*fontSize: `\$\{fontSize\}px`,\s*color: valueColor/,
    );
  });
});
