import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Contract: the portlet query-error UX fix (cinatra#1512) rides on UPSTREAM
 * drizzle-cube internals we cannot change (the error card is rendered by the
 * bundled `AnalyticsPortlet`, not by Cinatra code). Two Cinatra pieces depend
 * on those internals staying put:
 *
 *   1. The human-readable error copy: the query endpoint sends product
 *      language in the wire `error` field (`resolveAndValidateCubeId`'s
 *      `userMessage`), which only reaches the user because drizzle-cube's
 *      `CubeClient.load()` throws `new Error(errorData.error)` and the error
 *      card renders `error.message` verbatim.
 *
 *   2. The overflow containment: dashboard-theme.css gives the error card
 *      LOCAL overflow (`max-height: 100%; overflow: auto`) via a selector
 *      built from the card's utility classes (`dc:p-4 dc:border
 *      dc:rounded-sm`, direct child of the `dc:flex-1 dc:min-h-0` chart
 *      body) so its debug `<details>` expandables scroll INSIDE the portlet
 *      instead of being clipped by the portlet-level `overflow: hidden`
 *      (which stays — it is the rounded-corner clip).
 *
 * A drizzle-cube version bump that moves any of these would silently turn
 * the fix into a no-op — so, like dc-filter-bar-contract.test.ts, this test
 * pins the depended-on internals against the INSTALLED BUNDLE (via the
 * shipped sourcemaps), not against our own source.
 */

// pnpm symlinks the dep under the package's own node_modules; realpath
// through to the store so readdir works on the actual dist tree.
const DC_ROOT = realpathSync(
  join(__dirname, "..", "..", "node_modules", "drizzle-cube"),
);
const CHUNKS = join(DC_ROOT, "dist", "client", "chunks");

/** Load `basename → source` from the first chunk sourcemap matching `chunk`. */
function loadSources(chunk: RegExp): Map<string, string> {
  const mapFile = readdirSync(CHUNKS).find((f) => chunk.test(f));
  expect(
    mapFile,
    `drizzle-cube no longer ships a ${chunk} chunk sourcemap — re-verify the #1512 error-card contract`,
  ).toBeTruthy();
  const map = JSON.parse(readFileSync(join(CHUNKS, mapFile!), "utf-8")) as {
    sources: string[];
    sourcesContent: string[];
  };
  const byName = new Map<string, string>();
  map.sources.forEach((source, i) => {
    byName.set(source.split("/").pop()!, map.sourcesContent[i] ?? "");
  });
  return byName;
}

function getFrom(sources: Map<string, string>, name: string): string {
  const content = sources.get(name);
  expect(
    content,
    `${name} missing from the drizzle-cube bundle sourcemap — the #1512 error-card contract must be re-verified`,
  ).toBeTruthy();
  return content!;
}

// AnalyticsPortlet + DashboardPortletCard ship in the DashboardEditModal
// chunk; CubeClient ships in the chart-data-table chunk (v0.5.7 layout).
const editModalSources = loadSources(/^DashboardEditModal-.*\.js\.map$/);
const dataTableSources = loadSources(/^chart-data-table-.*\.js\.map$/);

const THEME_CSS = readFileSync(
  join(__dirname, "..", "components", "dashboard-theme.css"),
  "utf-8",
);

describe("drizzle-cube portlet error-card contract (cinatra#1512)", () => {
  it("CubeClient surfaces the wire `error` field as the thrown Error message", () => {
    const client = getFrom(dataTableSources, "CubeClient.ts");
    // The /load failure path: parse body, prefer `errorData.error`, throw it.
    expect(client).toMatch(/errorMessage\s*=\s*errorData\.error/);
    expect(client).toMatch(/throw new Error\(errorMessage\)/);
  });

  it("the error card renders error.message verbatim (where the endpoint copy lands)", () => {
    const portlet = getFrom(editModalSources, "AnalyticsPortlet.tsx");
    expect(portlet).toMatch(/error\.message \|\| error\.toString\(\)/);
  });

  it("the raw debug JSON stays behind collapsed, labeled <details> sections", () => {
    const portlet = getFrom(editModalSources, "AnalyticsPortlet.tsx");
    expect(portlet).toMatch(/<details>/);
    expect(portlet).toContain("portlet.queryWithFilters");
    expect(portlet).toContain("portlet.chartConfig");
    // The <pre> blocks own their inner two-axis scrolling.
    expect(portlet).toMatch(/dc:overflow-auto dc:max-h-20/);
  });

  it("the error-card root keeps the utility classes the containment selector targets", () => {
    const portlet = getFrom(editModalSources, "AnalyticsPortlet.tsx");
    // Card root: dc:p-4 dc:border dc:rounded-sm with an inline height.
    expect(portlet).toMatch(
      /className="dc:p-4 dc:border dc:rounded-sm"\s+style=\{\{\s*height/,
    );
    const card = getFrom(editModalSources, "DashboardPortletCard.tsx");
    // Chart body wrapper: the direct parent the `>` combinator relies on.
    expect(card).toMatch(/dc:flex-1 dc:min-h-0 dc:flex dc:flex-col/);
    expect(card).toMatch(/data-portlet-id=\{portlet\.id\}/);
  });

  it("dashboard-theme.css carries the scoped containment rule AND keeps the portlet clip", () => {
    // The containment rule: error card scrolls locally inside the portlet.
    expect(THEME_CSS).toMatch(
      /\[data-portlet-id\]\s*\n?\s*\.dc\\:flex-1\.dc\\:min-h-0\s*\n?\s*>\s*\.dc\\:p-4\.dc\\:border\.dc\\:rounded-sm\s*\{[^}]*max-height:\s*100%;[^}]*overflow:\s*auto;/,
    );
    // The portlet-level rounded-corner clip is untouched (containment is
    // LOCAL overflow on the card, not removal of the portlet clip).
    expect(THEME_CSS).toMatch(
      /\.dashboard-grid-container \[data-portlet-id\]\s*\{[^}]*overflow:\s*hidden;/,
    );
  });
});
