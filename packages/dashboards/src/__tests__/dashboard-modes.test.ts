import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * DGR-02 contract: the Grid/Rows layout toggle is opt-in via the
 * `DashboardsClientShell` `dashboardModes` prop (default `["grid"]` → no
 * toggle). Editable index dashboards enable `["grid","rows"]`; the personal
 * dashboard and read-only per-entity detail dashboards keep the default.
 *
 * Source assertions (no browser): drizzle-cube renders the toggle only when
 * `allowedModes.length > 1`, so the wiring IS the behaviour — visual placement
 * (DGR-01) is verified in a browser and the floating-overlay placement is
 * documented as deferred in `dashboard-theme.css`.
 */
const SRC = join(__dirname, "..");
const SHELL = readFileSync(
  join(SRC, "components", "dashboards-client-shell.tsx"),
  "utf-8",
);
const THEME_CSS = readFileSync(
  join(SRC, "components", "dashboard-theme.css"),
  "utf-8",
);
const read = (p: string) => readFileSync(join(SRC, "screens", p), "utf-8");

const ENABLED = [
  "agents-dashboard.tsx",
  "projects-dashboard.tsx",
  "teams-dashboard.tsx",
  "organizations-dashboard.tsx",
  "artifacts-dashboard.tsx",
];

describe("DashboardsClientShell dashboardModes prop (DGR-02)", () => {
  it("exposes a dashboardModes prop defaulting to ['grid'] and forwards it to CubeProvider", () => {
    expect(SHELL).toMatch(/dashboardModes\?:\s*readonly DashboardMode\[\]/);
    expect(SHELL).toMatch(/dashboardModes\s*=\s*\["grid"\]/); // default in the destructure
    expect(SHELL).toMatch(/dashboardModes=\{dashboardModes/); // forwarded to CubeProvider
  });

  it("enables ['grid','rows'] on every editable index dashboard", () => {
    for (const file of ENABLED) {
      expect(
        read(file),
        `${file} should pass dashboardModes={["grid", "rows"]}`,
      ).toMatch(/dashboardModes=\{\["grid",\s*"rows"\]\}/);
    }
  });

  it("does NOT enable rows mode on the personal dashboard (keeps the default)", () => {
    expect(read("personal-dashboard.tsx")).not.toMatch(/dashboardModes/);
  });

  it("keeps the read-only per-entity detail dashboards on the default (no toggle)", () => {
    expect(read("team-detail-dashboard.tsx")).not.toMatch(/dashboardModes/);
    expect(read("organization-detail-dashboard.tsx")).not.toMatch(/dashboardModes/);
  });
});

describe("Grid/Rows toggle → second-level sub-toolbar placement (DGR-01)", () => {
  it("positions the in-toolbar toggle into the sub-toolbar strip + right-aligns the gap-3 controls", () => {
    const idx = THEME_CSS.indexOf("Grid/Rows layout-mode toggle");
    expect(idx, "DGR-01 placement comment block must exist").toBeGreaterThan(-1);
    const block = THEME_CSS.slice(idx, idx + 2400);
    // the toggle wrapper is absolutely positioned into the reserved bottom strip
    expect(block).toMatch(/position:\s*absolute/);
    // the gap-3 sub-toolbar controls right-align so they clear the left-anchored toggle
    expect(block).toMatch(/justify-content:\s*flex-end/);
    // Cinatra-side CSS only — must target the in-toolbar toggle, never the
    // body-portaled floating overlay copy (no reparenting / no global override).
    expect(block).toMatch(/dc\\:gap-4/);
  });
});
