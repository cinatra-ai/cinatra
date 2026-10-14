/**
 * cinatra#4126 — the Artifacts console draws the tabs its drawing draws.
 *
 * The ratified drawing `specs/app-artifacts.html` (version 0.12.0, design@bda0cf8d) draws the console at
 * /configuration/artifacts with four tabs, in this order: Type definitions, Stored objects, Restore objects and
 * Review policy (§I, the console header; §IV, "One page, four tabs."). Each tab's panel is a surface of the
 * drawing's conformance manifest, `conformance/app-artifacts.json`, which this repository commits as a staged
 * copy (tests/e2e/design/conformance/manifests/app-artifacts.json, its bytes recorded in
 * scripts/design/__tests__/conformance-manifest-staging.test.mjs).
 *
 * The manifest names the drawing by its spec-source hash (`contentHash`, the sha256 of the spec's bytes) but does
 * not carry the tab labels. The labels below are read from the spec bytes that hash names, and this file holds the
 * committed copy to that hash: adopting a later drawing turns this file red until its tab list is read again from
 * the new bytes.
 *
 * The console page is a server component, so its wiring is pinned by source assertion, the repository's
 * established pattern (see ./review-policy-surface.test.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const MANIFEST = "tests/e2e/design/conformance/manifests/app-artifacts.json";
const CONSOLE_PAGE = "src/app/configuration/artifacts/page.tsx";
const CONSOLE_STRIP = "src/components/artifacts/console/console-tabs.tsx";

/** The spec-source hash of the drawing the tab list below was read from. */
const DRAWING_CONTENT_HASH = "sha256:f1d26ced35085568cc8286365a625939d77021d7836e03c46e0871468f415de9";

/** The console's tabs as the drawing draws them, in order, each with the manifest surface of its panel. */
const DRAWN_TABS = [
  { label: "Type definitions", panelSurface: "artifacts-type-definitions" },
  { label: "Stored objects", panelSurface: "objects-stored-list" },
  { label: "Restore objects", panelSurface: "restore-console" },
  { label: "Review policy", panelSurface: "review-policy" },
] as const;

type Manifest = { spec: string; contentHash: string; surfaces: Array<{ id: string }> };

const manifest = (): Manifest => JSON.parse(read(MANIFEST)) as Manifest;

/** CONSOLE_TABS as the console page declares it: its labels, in source order. */
function consoleTabLabels(): string[] {
  const block = /const CONSOLE_TABS = \[([\s\S]*?)\] as const;/.exec(read(CONSOLE_PAGE));
  if (block === null) {
    throw new Error(`${CONSOLE_PAGE} no longer declares CONSOLE_TABS as a const list — read the console's tab list again.`);
  }
  // Every entry of the list is read; an entry of another shape stops the reading instead of being left out.
  return (block[1].match(/\{[^{}]*\}/g) ?? []).map((entry) => {
    const tab = /^\{\s*value:\s*"[^"]+",\s*label:\s*"([^"]+)"\s*\}$/.exec(entry);
    if (tab === null) {
      throw new Error(`${CONSOLE_PAGE} declares a CONSOLE_TABS entry of another shape: ${entry}`);
    }
    return tab[1];
  });
}

describe("cinatra#4126 — the committed artifacts manifest is the drawing the tab list was read from", () => {
  it("names the drawing's spec bytes by their hash", () => {
    const committed = manifest();
    expect(committed.spec).toBe("specs/app-artifacts.html");
    expect(
      committed.contentHash,
      `${MANIFEST} names another drawing than the one DRAWN_TABS was read from — read the console's tabs again from the ` +
        "adopted spec bytes and update DRAWN_TABS and DRAWING_CONTENT_HASH together.",
    ).toBe(DRAWING_CONTENT_HASH);
  });

  it("declares each tab's panel surface, in the drawn tab order", () => {
    const ids = manifest().surfaces.map((surface) => surface.id);
    const missing = DRAWN_TABS.filter((tab) => !ids.includes(tab.panelSurface)).map((tab) => tab.panelSurface);
    expect(missing, `${MANIFEST} declares no panel surface for: ${missing.join(", ")}`).toEqual([]);
    const positions = DRAWN_TABS.map((tab) => ids.indexOf(tab.panelSurface));
    expect(positions, "the manifest declares the console's panel surfaces in another order than the drawn tabs").toEqual(
      [...positions].sort((a, b) => a - b),
    );
  });
});

describe("cinatra#4126 — the console's tab list is the drawn one", () => {
  it("CONSOLE_TABS names the drawn tabs, in the drawn order", () => {
    expect(consoleTabLabels()).toEqual(DRAWN_TABS.map((tab) => tab.label));
  });

  it("the console strip draws CONSOLE_TABS in their order under its tab list", () => {
    expect(read(CONSOLE_PAGE)).toContain("<ArtifactsConsoleTabs tabs={CONSOLE_TABS} activeTab={tab} />");
    // The tab list row holds the one map over the tabs, and each trigger draws its tab's own label.
    expect(read(CONSOLE_STRIP)).toMatch(
      /<TabsListRow data-testid="artifacts-console-tablist">\s*\{tabs\.map\(\(t\) => \(\s*<TabsTrigger key=\{t\.value\} value=\{t\.value\}[^>]*>\s*\{t\.label\}\s*<\/TabsTrigger>\s*\)\)\}\s*<\/TabsListRow>/,
    );
  });
});
