import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Contract: the dashboard filter-bar restyle (cinatra#65) is a SCOPED
 * CSS-VARIABLE REDEFINITION over drizzle-cube's third-party DOM
 * (`dashboard-theme.css` + `<DashboardFilterBarSlot>` in
 * composed-dashboard.tsx). It works only while the installed drizzle-cube
 * keeps painting the bar through specific inline `var(--dc-*)` styles and
 * a handful of utility-class hooks. A version bump that changes any of
 * those would turn the restyle into a silent no-op — so this test pins
 * the depended-on internals against the INSTALLED BUNDLE (via the
 * shipped sourcemaps), not against our own source.
 *
 * Pinned internals (each maps to a rule in dashboard-theme.css or to the
 * gating mirrored by dashboard-filter-bar-visibility.ts):
 *   1. DashboardFilterPanel's visibility gating (`!editable`,
 *      `!isEditMode && dashboardFilters.length === 0`).
 *   2. The bar root carries `dc:border dc:rounded-lg` and paints
 *      `var(--dc-surface)` / `var(--dc-border)` inline.
 *   3. Separators: `dc:w-px` div (desktop) + `dc:border-t` row (mobile).
 *   4. Hover via `--dc-surface-hover` mouse handlers.
 *   5. Popovers render IN-PLACE (`dc:absolute`, no createPortal) and the
 *      filter edit modal overlay is an inline `dc:fixed` — both are
 *      var-restored by the `.dc\:absolute` / `.dc\:fixed` scope rules.
 */

// pnpm symlinks the dep under the package's own node_modules; realpath
// through to the store so readdir works on the actual dist tree.
const DC_ROOT = realpathSync(
  join(__dirname, "..", "..", "node_modules", "drizzle-cube"),
);
const CHUNKS = join(DC_ROOT, "dist", "client", "chunks");

function loadFilterBarSources(): Map<string, string> {
  const mapFile = readdirSync(CHUNKS).find((f) =>
    /^DashboardEditModal-.*\.js\.map$/.test(f),
  );
  expect(
    mapFile,
    "drizzle-cube no longer ships a DashboardEditModal-*.js.map chunk — re-verify the filter-bar restyle contract",
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

const sources = loadFilterBarSources();
const get = (name: string): string => {
  const content = sources.get(name);
  expect(
    content,
    `${name} missing from the drizzle-cube bundle sourcemap — the filter-bar restyle contract must be re-verified`,
  ).toBeTruthy();
  return content!;
};

describe("drizzle-cube filter-bar restyle contract (dashboard-theme.css)", () => {
  it("DashboardFilterPanel keeps the visibility gating mirrored by useDashboardFilterBarVisible", () => {
    const panel = get("DashboardFilterPanel.tsx");
    expect(panel).toMatch(/if\s*\(!editable\)\s*\{?\s*\n?\s*return null/);
    expect(panel).toMatch(/!isEditMode\s*&&\s*dashboardFilters\.length\s*===\s*0/);
  });

  it("the bar root carries dc:border dc:rounded-lg and paints --dc-surface/--dc-border inline", () => {
    for (const file of ["CompactFilterBar.tsx", "DashboardFilterPanel.tsx"]) {
      const src = get(file);
      expect(src).toMatch(/className="dc:border dc:rounded-lg"/);
      expect(src).toContain("var(--dc-surface)");
      expect(src).toContain("var(--dc-border)");
    }
  });

  it("separators stay on the dc:w-px / dc:border-t hooks the hairline rules target", () => {
    const bar = get("CompactFilterBar.tsx");
    expect(bar).toMatch(/dc:w-px/);
    expect(bar).toMatch(/dc:border-t/);
  });

  it("hover keeps flowing through --dc-surface-hover", () => {
    const bar = get("CompactFilterBar.tsx");
    expect(bar).toContain("var(--dc-surface-hover)");
  });

  it("popovers render in-place (dc:absolute, unportaled) so the var-restore scope reaches them", () => {
    for (const file of [
      "CustomDateDropdown.tsx",
      "XTDDropdown.tsx",
      "FilterValuePopover.tsx",
    ]) {
      const src = get(file);
      expect(src).toMatch(/dc:absolute/);
      expect(src).not.toMatch(/createPortal/);
    }
  });

  it("the filter edit modal overlay stays an inline dc:fixed (var-restored, not portaled)", () => {
    const modal = get("DashboardFilterConfigModal.tsx");
    expect(modal).toMatch(/dc:fixed dc:inset-0/);
    expect(modal).not.toMatch(/createPortal/);
  });
});
