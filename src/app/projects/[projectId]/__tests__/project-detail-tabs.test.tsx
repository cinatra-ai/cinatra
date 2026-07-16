// @vitest-environment jsdom
//
// ProjectDetailTabs (cinatra#706) — the in-page tablist that replaced the
// route-based section nav on `/projects/[projectId]`. Proves the two-tab
// composition (Dashboards default + Permissions) and that switching mounts the
// Permissions content. The two heavy tab bodies are stubbed (the Dashboards
// shell pulls the drizzle-cube grid; the permissions client needs the App
// Router) — each is covered by its own suite; this locks the tab wiring.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../project-dashboards-tab", () => ({
  ProjectDashboardsTab: () => "DASHBOARDS_TAB_BODY",
}));
vi.mock("../permissions/permissions-tab-client", () => ({
  ProjectPermissionsTabClient: () => "PERMISSIONS_TAB_BODY",
}));

import { ProjectDetailTabs } from "../project-detail-tabs";

afterEach(cleanup);

// The stubs ignore their props, so bare shapes are enough to render.
const DASHBOARDS = { dataSource: {}, overviewPortlets: [] } as never;
const PERMISSIONS = {
  activeOrgId: null,
  projectId: "p1",
  projectName: "Apollo",
  canEdit: false,
  resourceOwner: null,
  coOwners: [],
  currentUserId: "u1",
  projectAccessRows: [],
  guestRows: [],
} as never;

describe("ProjectDetailTabs (#706)", () => {
  it("renders a Dashboards + Permissions tablist, defaulting to Dashboards", () => {
    render(<ProjectDetailTabs dashboards={DASHBOARDS} permissions={PERMISSIONS} />);

    expect(screen.getByRole("tab", { name: "Dashboards" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Permissions" })).toBeTruthy();

    // Default selection = Dashboards; Radix unmounts the inactive panel.
    expect(screen.getByText("DASHBOARDS_TAB_BODY")).toBeTruthy();
    expect(screen.queryByText("PERMISSIONS_TAB_BODY")).toBeNull();
  });

  it("mounts the Permissions content (with the ownership/access note) on switch", () => {
    render(<ProjectDetailTabs dashboards={DASHBOARDS} permissions={PERMISSIONS} />);

    // Radix Tabs selects on mouseDown (button 0), not a bare click.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Permissions" }));

    expect(screen.getByText("PERMISSIONS_TAB_BODY")).toBeTruthy();
    // The ownership-vs-access explainer heads the Permissions tab.
    expect(screen.getByText(/Ownership and access are separate/i)).toBeTruthy();
  });
});
