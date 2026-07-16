// @vitest-environment jsdom
//
// The Overview render for the org detail Dashboards tab (cinatra#705): the
// freshly-built entity-summary portlets render through <PortletHost>, and the
// dashboard-select + "+ New dashboard" controls render inside the standard
// toolbar (driven by the shell's EntityDashboardsContext). PortletHost is
// stubbed so this test does not pull the whole app portlet graph; the toolbar +
// drizzle-cube DashboardProvider are real (the same composition #701 proves).
import "./jsdom-shims";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import type { PortletInstanceProp } from "@/components/dashboards/portlet-host";

vi.mock("@/components/dashboards/portlet-host", () => ({
  PortletHost: ({ portlets }: { portlets: readonly PortletInstanceProp[] }) => (
    <div
      data-testid="portlet-host"
      data-portlets={String(portlets.length)}
      data-kinds={portlets.map((p) => p.kind).join(",")}
    />
  ),
}));

import { OrganizationOverviewDashboard } from "../organization-overview-dashboard";
import {
  EntityDashboardsProvider,
  type EntityDashboardsContextValue,
} from "../entity-dashboards-context";

afterEach(cleanup);

const PORTLETS: PortletInstanceProp[] = [
  { instanceId: "overview-metadata", kind: "entity-metadata", version: "1.0.0", slot: "fixed", config: { title: "Organization", items: [] } },
  { instanceId: "overview-counts", kind: "entity-count", version: "1.0.0", slot: "fixed", config: { items: [] } },
];

function ctx(overrides: Partial<EntityDashboardsContextValue> = {}): EntityDashboardsContextValue {
  return {
    dashboards: [
      { id: "ov", name: "Overview", isDefault: true, canWrite: true },
      { id: "sales", name: "Sales", isDefault: false, canWrite: true },
    ],
    selectedId: "ov",
    pendingId: null,
    canCreate: true,
    busy: false,
    onSelect: vi.fn(),
    onCreate: vi.fn(async () => ({ ok: true as const })),
    onRename: vi.fn(async () => ({ ok: true as const })),
    onDelete: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

function renderOverview(value: EntityDashboardsContextValue) {
  return render(
    <EntityDashboardsProvider value={value}>
      <OrganizationOverviewDashboard portlets={PORTLETS} pageAnchor="org-detail" />
    </EntityDashboardsProvider>,
  );
}

describe("OrganizationOverviewDashboard", () => {
  test("renders the freshly-built summary portlets through PortletHost", () => {
    renderOverview(ctx());
    const host = screen.getByTestId("portlet-host");
    expect(host.getAttribute("data-portlets")).toBe("2");
    expect(host.getAttribute("data-kinds")).toBe("entity-metadata,entity-count");
  });

  test("shows the dashboard-select + '+ New dashboard' controls inside the toolbar", () => {
    renderOverview(ctx());
    const toolbar = document.querySelector<HTMLElement>(
      "[data-cinatra-dashboard-toolbar]",
    );
    expect(toolbar).not.toBeNull();
    expect(
      within(toolbar as HTMLElement).getByRole("button", { name: "Select dashboard" }),
    ).toBeTruthy();
    // The select trigger reflects the current (Overview) selection.
    expect(within(toolbar as HTMLElement).getByText("Overview")).toBeTruthy();
    expect(
      within(toolbar as HTMLElement).getByRole("button", { name: /New dashboard/ }),
    ).toBeTruthy();
  });

  test("is render-only: the Overview exposes no Edit dashboard affordance", () => {
    renderOverview(ctx());
    expect(screen.queryByRole("button", { name: "Edit dashboard" })).toBeNull();
    // Overview is non-removable — the manage (rename/delete) menu never shows for it.
    expect(screen.queryByRole("button", { name: /^Manage / })).toBeNull();
  });

  test("hides the New dashboard control when the actor cannot create", () => {
    renderOverview(ctx({ canCreate: false }));
    expect(screen.queryByRole("button", { name: /New dashboard/ })).toBeNull();
  });
});
