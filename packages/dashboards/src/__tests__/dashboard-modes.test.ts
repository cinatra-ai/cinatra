import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Contract: the Grid/Rows layout toggle is opt-in via the
 * `DashboardsClientShell` `dashboardModes` prop (default `["grid"]` → no
 * toggle). Editable index dashboards enable `["grid","rows"]`; the personal
 * dashboard and read-only per-entity detail dashboards keep the default.
 *
 * Source assertions (no browser): the host toolbar renders the toggle only
 * when `allowedModes.length > 1` (behaviour covered by
 * `components/__tests__/cinatra-dashboard-toolbar.test.tsx`), so the wiring
 * IS the behaviour. The value flows shell → `<CubeProvider>` →
 * `useCubeFeatures()` → `<DashboardProvider>`; the second leg lives in
 * `composed-dashboard.tsx` and is asserted below.
 */
const SRC = join(__dirname, "..");
const SHELL = readFileSync(
  join(SRC, "components", "dashboards-client-shell.tsx"),
  "utf-8",
);
const COMPOSED = readFileSync(
  join(SRC, "components", "composed-dashboard.tsx"),
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

describe("DashboardsClientShell dashboardModes prop", () => {
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

describe("dashboardModes reaches the dashboard state machine", () => {
  it("ComposedDashboard forwards the CubeProvider value into DashboardProvider", () => {
    // The shell's declared modes only gate the toggle if the composition
    // reads them back out of the cube context and hands them to the
    // provider — a directly-mounted provider would otherwise fall back to
    // upstream's permissive ['rows','grid'] default. Match the actual call
    // site (destructure + JSX forward), not prose in comments. The runtime
    // proof (toggle gated by the shell's modes) lives in
    // `components/__tests__/composed-dashboard.test.tsx`.
    expect(COMPOSED).toMatch(
      /const\s*\{\s*dashboardModes\s*\}\s*=\s*useCubeFeatures\(\)/,
    );
    expect(COMPOSED).toMatch(/dashboardModes=\{dashboardModes\}/);
  });
});
