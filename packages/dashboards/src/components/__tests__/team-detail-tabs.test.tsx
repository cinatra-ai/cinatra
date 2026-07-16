// @vitest-environment jsdom
//
// Covers the `/teams/[teamId]` tabbed surface glue (cinatra#704): the tablist,
// the Overview-aware renderer, and the Permissions slot. The renderer branch is
// the per-surface seam OVER the landed shell (#701) + Overview portlets (#702) —
// so this test drives the REAL `<EntityDashboardsShell>` + real toolbar controls
// with a mocked data source, and asserts:
//   - both tabs render; Dashboards is the default;
//   - the non-removable Overview renders the team summary AS render-only
//     portlets (entity-metadata identity + entity-count members) — NOT the DC
//     grid — with the dashboard-select + "+ New dashboard" primary controls;
//   - the Permissions tab shows the team access slot, with NO customer-invite
//     affordance (customers are project-only).
//
// The heavy leaves are mocked: the embedded DC grid (never rendered on the
// Overview path; its real mount is proven by embedded-drizzle-cube-dashboard-grid
// .test) and `<PortletHost>` (its real render of these exact entity-summary
// portlets is proven by portlet-host.test + overview-config.test). This isolates
// the #704 wiring.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/team-detail-tabs.test.tsx

import "./jsdom-shims";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

// The DC grid is only reached for a NON-default (custom) dashboard; the Overview
// path never mounts it. Mock it so importing the tab shell pulls no
// drizzle-cube/client into this test.
vi.mock("../embedded-drizzle-cube-dashboard-grid", () => ({
  EmbeddedDrizzleCubeDashboardGrid: (props: { editable?: boolean }) => (
    <div data-testid="grid-mock" data-editable={String(props.editable)} />
  ),
}));

// PortletHost's real render of the entity-summary kinds is covered elsewhere;
// here we assert MY renderer hands it the freshly-composed Overview portlets.
vi.mock("@/components/dashboards/portlet-host", () => ({
  PortletHost: ({
    portlets,
  }: {
    portlets: ReadonlyArray<{
      instanceId: string;
      kind: string;
      config: { title?: string; items?: ReadonlyArray<{ label: string; value: string | number }> };
    }>;
  }) => (
    <div data-testid="portlet-host">
      {portlets.map((p) => (
        <div key={p.instanceId} data-kind={p.kind}>
          {p.config.title ? <span>{p.config.title}</span> : null}
          {(p.config.items ?? []).map((it, i) => (
            <span key={i}>{`${it.label}: ${it.value}`}</span>
          ))}
        </div>
      ))}
    </div>
  ),
}));

import { TeamDetailTabs } from "../team-detail-tabs";
import { buildTeamOverviewConfig } from "../seed-configs/overview-config";
import type { DashboardConfigV1_1 } from "../../store/dashboard-config";
import type {
  EntityDashboardSummary,
  EntityDashboardsDataSource,
  EntityDashboardsList,
} from "../../entity-dashboards-contract";

afterEach(cleanup);

const OVERVIEW: EntityDashboardSummary = {
  id: "ov",
  name: "Overview",
  isDefault: true,
  canWrite: true,
};

const EMPTY_CONFIG = {
  portlets: [],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as unknown as DashboardConfigV1_1;

function makeDataSource(
  overrides: Partial<EntityDashboardsDataSource> = {},
  list: EntityDashboardsList = { dashboards: [OVERVIEW], canCreate: true },
): EntityDashboardsDataSource {
  return {
    listDashboards: vi.fn(async () => list),
    loadConfig: vi.fn(async () => EMPTY_CONFIG),
    createDashboard: vi.fn(async (name: string) => ({
      ok: true as const,
      dashboard: { id: `new-${name}`, name, isDefault: false, canWrite: true },
    })),
    renameDashboard: vi.fn(async (id: string, name: string) => ({
      ok: true as const,
      dashboard: { id, name, isDefault: false, canWrite: true },
    })),
    deleteDashboard: vi.fn(async () => ({ ok: true as const })),
    saveDashboard: vi.fn(async () => {}),
    ...overrides,
  };
}

const OVERVIEW_PORTLETS = buildTeamOverviewConfig({
  name: "Acme Team",
  organizationName: "Acme Inc",
  memberCount: 3,
}).portlets;

function renderTabs(opts: {
  dataSource?: EntityDashboardsDataSource;
  list?: EntityDashboardsList;
  permissionsSlot?: React.ReactNode;
} = {}) {
  const list = opts.list ?? { dashboards: [OVERVIEW], canCreate: true };
  const dataSource = opts.dataSource ?? makeDataSource({}, list);
  return render(
    <TeamDetailTabs
      dataSource={dataSource}
      overviewPortlets={OVERVIEW_PORTLETS}
      initialData={{ list, selectedId: OVERVIEW.id, config: EMPTY_CONFIG }}
      permissionsSlot={
        opts.permissionsSlot ?? (
          <div data-testid="perms-slot">Team access configuration</div>
        )
      }
    />,
  );
}

describe("TeamDetailTabs — tablist", () => {
  test("renders a Dashboards tab and a Permissions tab, Dashboards active first", () => {
    renderTabs();
    expect(screen.getByRole("tab", { name: "Dashboards" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Permissions" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Dashboards" }).getAttribute("data-state"),
    ).toBe("active");
  });
});

describe("TeamDetailTabs — Dashboards tab (Overview = team info)", () => {
  test("the Overview renders the team summary as render-only portlets (no DC grid)", () => {
    renderTabs();
    // Overview default selected → the render-only summary, not the grid.
    expect(screen.getByTestId("portlet-host")).toBeTruthy();
    expect(screen.queryByTestId("grid-mock")).toBeNull();
    // entity-metadata identity block + entity-count members block.
    expect(screen.getByText("Team")).toBeTruthy(); // metadata block title
    expect(screen.getByText("Name: Acme Team")).toBeTruthy();
    expect(screen.getByText("Organization: Acme Inc")).toBeTruthy();
    expect(screen.getByText("Members: 3")).toBeTruthy();
  });

  test("the Overview carries the dashboard-select + New dashboard primary controls", () => {
    renderTabs();
    const toolbar = document.querySelector<HTMLElement>(
      "[data-cinatra-dashboard-toolbar]",
    );
    expect(toolbar).not.toBeNull();
    expect(
      within(toolbar as HTMLElement).getByRole("button", { name: "Select dashboard" }),
    ).toBeTruthy();
    expect(within(toolbar as HTMLElement).getByText("Overview")).toBeTruthy();
    expect(
      within(toolbar as HTMLElement).getByRole("button", { name: /New dashboard/ }),
    ).toBeTruthy();
  });

  test("the non-removable Overview shows no rename/delete (manage) affordance", () => {
    renderTabs();
    expect(screen.queryByRole("button", { name: /^Manage / })).toBeNull();
  });

  test("no New dashboard control when the actor cannot create", () => {
    renderTabs({
      list: { dashboards: [{ ...OVERVIEW, canWrite: false }], canCreate: false },
    });
    expect(screen.queryByRole("button", { name: /New dashboard/ })).toBeNull();
  });
});

describe("TeamDetailTabs — Permissions tab", () => {
  test("selecting Permissions shows the team access slot; no customer-invite affordance", () => {
    renderTabs();
    // Radix unmounts inactive content, so the slot is absent until selected.
    expect(screen.queryByTestId("perms-slot")).toBeNull();

    // Radix TabsTrigger activates on onMouseDown (or focus), not a bare click.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Permissions" }));

    expect(screen.getByTestId("perms-slot")).toBeTruthy();
    // Customers are a project-only concept — the team surface never offers one.
    expect(screen.queryByText(/customer/i)).toBeNull();
  });
});
