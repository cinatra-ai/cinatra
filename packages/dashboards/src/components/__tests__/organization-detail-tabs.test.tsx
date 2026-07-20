// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { EntityDashboardRenderArgs } from "../entity-dashboards-shell";
import type {
  EntityDashboardSummary,
  EntityDashboardsDataSource,
} from "../../entity-dashboards-contract";
import type { DashboardConfigV1_1 } from "../../store/dashboard-config";
import type { PortletInstanceProp } from "@/components/dashboards/portlet-host";

// Capture the props the shell is mounted with, and render the Overview seam
// once so we can assert it delegates correctly, without pulling the real shell
// state machine (proven by #701) or drizzle-cube into this test.
const shellProps = vi.fn();
vi.mock("../entity-dashboards-shell", () => ({
  EntityDashboardsShell: (props: Record<string, unknown>) => {
    shellProps(props);
    return <div data-testid="entity-shell" data-anchor={String(props.pageAnchor)} />;
  },
}));

vi.mock("../organization-overview-dashboard", () => ({
  OrganizationOverviewDashboard: (props: {
    portlets: readonly PortletInstanceProp[];
    pageAnchor: string;
  }) => (
    <div
      data-testid="overview-dashboard"
      data-anchor={props.pageAnchor}
      data-portlets={String(props.portlets.length)}
    />
  ),
}));

vi.mock("../embedded-drizzle-cube-dashboard-grid", () => ({
  EmbeddedDrizzleCubeDashboardGrid: (props: {
    dashboard: DashboardConfigV1_1;
    editable?: boolean;
  }) => (
    <div
      data-testid="analytics-grid"
      data-editable={String(props.editable)}
      data-portlets={String((props.dashboard.portlets ?? []).length)}
    />
  ),
}));

import {
  OrganizationDetailTabs,
  makeRenderOrganizationDashboard,
} from "../organization-detail-tabs";

afterEach(() => {
  cleanup();
  shellProps.mockClear();
});

const OVERVIEW_PORTLETS: PortletInstanceProp[] = [
  { instanceId: "overview-metadata", kind: "entity-metadata", version: "1.0.0", slot: "fixed", config: {} },
  { instanceId: "overview-counts", kind: "entity-count", version: "1.0.0", slot: "fixed", config: {} },
];

function makeDataSource(): EntityDashboardsDataSource {
  return {
    listDashboards: vi.fn(),
    loadConfig: vi.fn(),
    createDashboard: vi.fn(),
    saveDashboard: vi.fn(),
  } as unknown as EntityDashboardsDataSource;
}

describe("OrganizationDetailTabs — tablist", () => {
  test("renders a Dashboards tab and a Permissions tab", () => {
    render(
      <OrganizationDetailTabs
        dataSource={makeDataSource()}
        overviewPortlets={OVERVIEW_PORTLETS}
        permissionsSlot={<div data-testid="perm-slot">permissions</div>}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Dashboards", "Permissions"]);
  });

  test("Dashboards is the default tab and hosts the entity dashboards shell with the org-detail anchor", () => {
    const ds = makeDataSource();
    render(
      <OrganizationDetailTabs
        dataSource={ds}
        overviewPortlets={OVERVIEW_PORTLETS}
        permissionsSlot={<div data-testid="perm-slot">permissions</div>}
      />,
    );
    const shell = screen.getByTestId("entity-shell");
    expect(shell.getAttribute("data-anchor")).toBe("org-detail");
    // The bound data source + the Overview-aware render seam are threaded in.
    const props = shellProps.mock.calls[0][0];
    expect(props.dataSource).toBe(ds);
    expect(props.pageAnchor).toBe("org-detail");
    expect(typeof props.renderDashboard).toBe("function");
    // Permissions content is not mounted until its tab is active (radix unmounts
    // inactive panels).
    expect(screen.queryByTestId("perm-slot")).toBeNull();
  });

  test("activating the Permissions tab reveals the permissions slot", () => {
    render(
      <OrganizationDetailTabs
        dataSource={makeDataSource()}
        overviewPortlets={OVERVIEW_PORTLETS}
        permissionsSlot={<div data-testid="perm-slot">permissions</div>}
      />,
    );
    const permissionsTab = screen.getByRole("tab", { name: "Permissions" });
    fireEvent.mouseDown(permissionsTab);
    permissionsTab.focus();
    fireEvent.click(permissionsTab);
    expect(screen.getByTestId("perm-slot")).toBeTruthy();
  });

  // cinatra#1510 — the Manage tab exists ONLY when a manageSlot is handed down
  // (i.e. the viewer holds organization.update in the viewed org). A read-only
  // member gets no slot and therefore no Manage tab.
  test("omits the Manage tab when no manageSlot is provided (read-only member)", () => {
    render(
      <OrganizationDetailTabs
        dataSource={makeDataSource()}
        overviewPortlets={OVERVIEW_PORTLETS}
        permissionsSlot={<div data-testid="perm-slot">permissions</div>}
      />,
    );
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Dashboards",
      "Permissions",
    ]);
    expect(screen.queryByRole("tab", { name: "Manage" })).toBeNull();
  });

  test("renders the Manage tab when a manageSlot is provided (org_admin+) and reveals it on activation", () => {
    render(
      <OrganizationDetailTabs
        dataSource={makeDataSource()}
        overviewPortlets={OVERVIEW_PORTLETS}
        permissionsSlot={<div data-testid="perm-slot">permissions</div>}
        manageSlot={<div data-testid="manage-slot">manage</div>}
      />,
    );
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Dashboards",
      "Permissions",
      "Manage",
    ]);
    // Inactive panel is not mounted until its tab is active.
    expect(screen.queryByTestId("manage-slot")).toBeNull();
    const manageTab = screen.getByRole("tab", { name: "Manage" });
    fireEvent.mouseDown(manageTab);
    manageTab.focus();
    fireEvent.click(manageTab);
    expect(screen.getByTestId("manage-slot")).toBeTruthy();
  });
});

describe("makeRenderOrganizationDashboard — Overview-aware render seam", () => {
  function args(summary: EntityDashboardSummary): EntityDashboardRenderArgs {
    return {
      summary,
      config: {
        portlets: [{ id: "a" }, { id: "b" }],
      } as unknown as DashboardConfigV1_1,
      editable: summary.canWrite,
      onSave: vi.fn(),
      pageAnchor: "org-detail",
      dashboardModes: ["grid"],
    };
  }

  test("renders the Overview (isDefault) as the org overview portlet dashboard", () => {
    const render_ = makeRenderOrganizationDashboard(OVERVIEW_PORTLETS);
    render(
      <>{render_(args({ id: "ov", name: "Overview", isDefault: true, canWrite: true }))}</>,
    );
    const overview = screen.getByTestId("overview-dashboard");
    expect(overview.getAttribute("data-portlets")).toBe("2");
    expect(overview.getAttribute("data-anchor")).toBe("org-detail");
    expect(screen.queryByTestId("analytics-grid")).toBeNull();
  });

  test("renders a non-default dashboard as the editable analytics grid", () => {
    const render_ = makeRenderOrganizationDashboard(OVERVIEW_PORTLETS);
    render(
      <>{render_(args({ id: "sales", name: "Sales", isDefault: false, canWrite: true }))}</>,
    );
    const grid = screen.getByTestId("analytics-grid");
    expect(grid.getAttribute("data-editable")).toBe("true");
    expect(grid.getAttribute("data-portlets")).toBe("2");
    expect(screen.queryByTestId("overview-dashboard")).toBeNull();
  });
});
