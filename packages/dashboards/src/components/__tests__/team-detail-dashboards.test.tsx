// @vitest-environment jsdom
//
// Covers the `/teams/[teamId]` dashboards-surface glue (cinatra#704, reshaped
// by cinatra#1688): the Overview-aware renderer over the landed shell (#701) +
// Overview portlets (#702). This test drives the REAL `<EntityDashboardsShell>`
// + real toolbar controls with a mocked data source, and asserts:
//   - the non-removable Overview renders the team summary AS render-only
//     portlets (entity-metadata identity + entity-count members) — NOT the DC
//     grid — with the dashboard-select + "+ New dashboard" primary controls;
//   - there is NO tablist and NO Permissions surface here (cinatra#1688: the
//     former Permissions tab duplicated the members UI that
//     `/teams/[teamId]/settings` hosts — the settings page is THE single
//     team-management surface).
//
// The heavy leaves are mocked: the embedded DC grid (never rendered on the
// Overview path; its real mount is proven by embedded-drizzle-cube-dashboard-grid
// .test) and `<PortletHost>` (its real render of these exact entity-summary
// portlets is proven by portlet-host.test + overview-config.test). This isolates
// the surface wiring.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/team-detail-dashboards.test.tsx

import "./jsdom-shims";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// The DC grid is only reached for a NON-default (custom) dashboard; the Overview
// path never mounts it. Mock it so importing the surface pulls no
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

import { TeamDetailDashboards } from "../team-detail-dashboards";
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
    saveDashboard: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

const OVERVIEW_PORTLETS = buildTeamOverviewConfig({
  name: "Acme Team",
  organizationName: "Acme Inc",
  memberCount: 3,
}).portlets;

function renderSurface(opts: {
  dataSource?: EntityDashboardsDataSource;
  list?: EntityDashboardsList;
} = {}) {
  const list = opts.list ?? { dashboards: [OVERVIEW], canCreate: true };
  const dataSource = opts.dataSource ?? makeDataSource({}, list);
  return render(
    <TeamDetailDashboards
      dataSource={dataSource}
      overviewPortlets={OVERVIEW_PORTLETS}
      initialData={{ list, selectedId: OVERVIEW.id, config: EMPTY_CONFIG }}
    />,
  );
}

describe("TeamDetailDashboards — Overview (team info)", () => {
  test("the Overview renders the team summary as render-only portlets (no DC grid)", () => {
    renderSurface();
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
    renderSurface();
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
    renderSurface();
    expect(screen.queryByRole("button", { name: /^Manage / })).toBeNull();
  });

  test("no New dashboard control when the actor cannot create", () => {
    renderSurface({
      list: { dashboards: [{ ...OVERVIEW, canWrite: false }], canCreate: false },
    });
    expect(screen.queryByRole("button", { name: /New dashboard/ })).toBeNull();
  });
});

describe("TeamDetailDashboards — no Permissions surface (cinatra#1688)", () => {
  test("renders no tablist and no Permissions tab — management lives on /settings", () => {
    renderSurface();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("Permissions")).toBeNull();
  });
});
