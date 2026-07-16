// @vitest-environment jsdom
//
// ProjectDashboardsTab render-seam routing (cinatra#706). The tab hands the
// reusable entity Dashboards shell (#701) a `renderDashboard` override; this
// locks the routing decision: the non-removable Overview default renders the
// render-only project-summary view (#702), and every OTHER dashboard renders
// through the editable drizzle-cube grid. The shell, grid, and Overview view
// are stubbed (the real grid pulls drizzle-cube/client) so the test exercises
// the override in isolation, driving it with a crafted render-args.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  args: null as unknown,
}));

// The stub shell simply invokes the override the tab passes it, with whatever
// render-args the current test staged — so we observe exactly what the tab
// routes each dashboard to.
vi.mock("@cinatra-ai/dashboards/entity-dashboards-shell", () => ({
  EntityDashboardsShell: (props: { renderDashboard: (a: unknown) => unknown }) =>
    props.renderDashboard(state.args),
}));
vi.mock("@/components/dashboards/embedded-drizzle-cube-dashboard-grid", () => ({
  EmbeddedDrizzleCubeDashboardGrid: () => "GRID_RENDER",
}));
vi.mock("../project-overview-dashboard", () => ({
  ProjectOverviewDashboard: () => "OVERVIEW_RENDER",
}));

import { ProjectDashboardsTab } from "../project-dashboards-tab";

afterEach(cleanup);

function renderArgs(isDefault: boolean) {
  return {
    summary: {
      id: isDefault ? "ov" : "sales",
      name: isDefault ? "Overview" : "Sales",
      isDefault,
      canWrite: true,
    },
    config: { portlets: [], layoutMode: "grid", grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 } },
    editable: true,
    onSave: async () => {},
    pageAnchor: "project-detail",
    dashboardModes: ["grid"],
  };
}

// The shell is stubbed, so the data source is never invoked here.
const PROPS = { dataSource: {} as never, overviewPortlets: [] };

describe("ProjectDashboardsTab render seam (#706)", () => {
  it("routes the non-removable Overview to the render-only overview view", () => {
    state.args = renderArgs(true);
    render(<ProjectDashboardsTab {...PROPS} />);
    expect(screen.getByText("OVERVIEW_RENDER")).toBeTruthy();
    expect(screen.queryByText("GRID_RENDER")).toBeNull();
  });

  it("routes a user-created dashboard to the editable analytics grid", () => {
    state.args = renderArgs(false);
    render(<ProjectDashboardsTab {...PROPS} />);
    expect(screen.getByText("GRID_RENDER")).toBeTruthy();
    expect(screen.queryByText("OVERVIEW_RENDER")).toBeNull();
  });
});
