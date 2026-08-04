import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Contract: the edit-mode drag/resize affordance fix (cinatra#2408) is a
 * SCOPED CSS OVERRIDE of react-grid-layout 2.2.3 internals bundled by
 * `drizzle-cube/dist/client/styles.css`. It depends on:
 *
 *   1. The stock resize-handle selectors and their default (mid-edge,
 *      20x20, no cursor guard) geometry — so `dashboard-theme.css` knows
 *      exactly which selectors to stretch.
 *   2. The stock drop-placeholder selector (`.react-grid-item.react-grid-
 *      placeholder`) and its `background: red` default.
 *   3. The `.resizing` / `.react-draggable-dragging` state classes RGL
 *      applies to the ACTIVE grid item during a drag/resize.
 *
 * A drizzle-cube/react-grid-layout bump that renames a class, changes the
 * stock geometry, or restructures the resize-handle DOM would silently
 * turn the override into a no-op (or make it target the wrong element) —
 * so, like `portlet-error-card-contract.test.ts` and
 * `dc-filter-bar-contract.test.ts`, this test pins the depended-on
 * internals against the INSTALLED BUNDLE, not against our own source.
 */

// pnpm symlinks the dep under the package's own node_modules; realpath
// through to the store so the styles.css read hits the real file.
const DC_ROOT = realpathSync(
  join(__dirname, "..", "..", "node_modules", "drizzle-cube"),
);
const DC_STYLES = readFileSync(
  join(DC_ROOT, "dist", "client", "styles.css"),
  "utf-8",
);

const THEME_CSS_PATH = join(
  __dirname,
  "..",
  "components",
  "dashboard-theme.css",
);
const THEME_CSS = readFileSync(THEME_CSS_PATH, "utf-8");

describe("react-grid-layout stock CSS (pinned bundle internals, cinatra#2408)", () => {
  it("side resize handles are still centered at the edge midpoint by default", () => {
    // If RGL ever ships full-edge handles itself, our stretch override
    // becomes redundant (harmless) but the "why" comment goes stale —
    // re-verify the fix is still needed.
    expect(DC_STYLES).toMatch(
      /\.react-grid-item>\.react-resizable-handle\.react-resizable-handle-w,\.react-grid-item>\.react-resizable-handle\.react-resizable-handle-e\{cursor:ew-resize;margin-top:-10px;top:50%\}/,
    );
    expect(DC_STYLES).toMatch(
      /\.react-grid-item>\.react-resizable-handle\.react-resizable-handle-n,\.react-grid-item>\.react-resizable-handle\.react-resizable-handle-s\{cursor:ns-resize;margin-left:-10px;left:50%\}/,
    );
  });

  it("corner resize handles stay pinned 20x20 squares rendered after the sides", () => {
    // The override relies on corners painting (and hit-testing) above the
    // now-stretched side handles because they appear LATER in the RGL
    // resizeHandles DOM order — confirm the corner rules exist unchanged.
    for (const corner of ["se", "sw", "ne", "nw"]) {
      expect(DC_STYLES).toContain(
        `.react-grid-item>.react-resizable-handle.react-resizable-handle-${corner}`,
      );
    }
  });

  it("the drop placeholder is still the stock class + red background", () => {
    expect(DC_STYLES).toMatch(
      /\.react-grid-item\.react-grid-placeholder\{opacity:\.2;z-index:2;-webkit-user-select:none;user-select:none;background:red;transition-duration:\.1s\}/,
    );
  });

  it("RGL still applies .resizing / .react-draggable-dragging to the active item only", () => {
    expect(DC_STYLES).toContain(
      ".react-grid-item.resizing{z-index:1;will-change:width, height;transition:none}",
    );
    expect(DC_STYLES).toContain(
      ".react-grid-item.react-draggable-dragging{z-index:3;will-change:transform;transition:none}",
    );
  });

  it("no stock user-select guard exists on the grid item during drag/resize", () => {
    // If RGL ever adds its own user-select:none on .resizing /
    // .react-draggable-dragging, our guard becomes redundant — harmless,
    // but confirms the gap this override closes.
    expect(DC_STYLES).not.toMatch(
      /\.react-grid-item\.resizing\{[^}]*user-select:\s*none/,
    );
    expect(DC_STYLES).not.toMatch(
      /\.react-grid-item\.react-draggable-dragging\{[^}]*user-select:\s*none/,
    );
  });
});

describe("dashboard-theme.css carries the #2408 affordance overrides", () => {
  it("grab/grabbing cursor on the drag handle", () => {
    expect(THEME_CSS).toMatch(
      /\.dashboard-grid-container \[data-portlet-id\] > \.portlet-drag-handle \{\s*cursor: grab;/,
    );
    // `.react-draggable-dragging` lands on the OUTER `.react-grid-item`
    // wrapper (a distinct ancestor element, NOT `[data-portlet-id]` itself —
    // react-grid-layout wraps each child in its own item div rather than
    // cloning props onto it), so the grabbing rule must select DOWN through
    // `[data-portlet-id]` from that wrapper, not treat it as the dragging
    // element.
    expect(THEME_CSS).toMatch(
      /\.portlet-drag-handle:active,\s*\.dashboard-grid-container\s*\n?\s*\.react-grid-item\.react-draggable-dragging\s*\n?\s*> \[data-portlet-id\]\s*\n?\s*> \.portlet-drag-handle \{\s*cursor: grabbing;/,
    );
  });

  it("side resize handles are stretched to the full edge (not the stock 20px midpoint), rotation reset", () => {
    // The handles are direct children of `.react-grid-item` — SIBLINGS of
    // `[data-portlet-id]`, not its descendants (confirmed against the live
    // DOM: DashboardPortletCard's `data-portlet-id` root and the resize
    // handles are both direct children of the same `.react-grid-item`).
    expect(THEME_CSS).toMatch(
      /\.react-resizable-handle\.react-resizable-handle-w,\s*\n\.dashboard-grid-container \.react-grid-item > \.react-resizable-handle\.react-resizable-handle-e \{\s*top: 0;\s*height: 100%;\s*margin-top: 0;\s*transform: none;/,
    );
    expect(THEME_CSS).toMatch(
      /\.react-resizable-handle\.react-resizable-handle-n,\s*\n\.dashboard-grid-container \.react-grid-item > \.react-resizable-handle\.react-resizable-handle-s \{\s*left: 0;\s*width: 100%;\s*margin-left: 0;\s*transform: none;/,
    );
  });

  it("the stock RGL rotate() this override must cancel is still present on -e/-w/-n/-s (pinned)", () => {
    // If a future react-grid-layout bump drops the shared-icon rotate()
    // trick, this override's `transform: none` becomes a harmless no-op —
    // but if it instead CHANGES the rotation mechanism, re-verify the fix.
    expect(DC_STYLES).toMatch(
      /\.react-grid-item>\.react-resizable-handle\.react-resizable-handle-e\{right:0;transform:rotate\(315deg\)\}/,
    );
    expect(DC_STYLES).toMatch(
      /\.react-grid-item>\.react-resizable-handle\.react-resizable-handle-w\{left:0;transform:rotate\(135deg\)\}/,
    );
  });

  it("user-select and pointer-events guards scope to an active drag/resize via :has() on .react-grid-item", () => {
    expect(THEME_CSS).toMatch(
      /\.dashboard-grid-container:has\(\.react-grid-item\.resizing\),\s*\n\.dashboard-grid-container:has\(\.react-grid-item\.react-draggable-dragging\) \{\s*user-select: none;/,
    );
    expect(THEME_CSS).toContain(
      ".dashboard-grid-container:has(.react-grid-item.resizing) .react-grid-item:not(.resizing),",
    );
    expect(THEME_CSS).toMatch(
      /\.react-grid-item:not\(\.react-draggable-dragging\) \{\s*pointer-events: none;/,
    );
  });

  it("the drop placeholder is recolored neutral and rounded to match the widget radius", () => {
    expect(THEME_CSS).toMatch(
      /\.dashboard-grid-container \.react-grid-item\.react-grid-placeholder \{\s*background: color-mix\(in srgb, var\(--line-strong\) 40%, var\(--surface-muted\)\);\s*border-radius: var\(--radius-xl, 0\.75rem\);/,
    );
    // Never reintroduce the stock red.
    const placeholderRuleMatch = THEME_CSS.match(
      /\.dashboard-grid-container \.react-grid-item\.react-grid-placeholder \{[^}]*\}/,
    );
    expect(placeholderRuleMatch).toBeTruthy();
    expect(placeholderRuleMatch![0]).not.toMatch(/background:\s*red/);
  });
});
