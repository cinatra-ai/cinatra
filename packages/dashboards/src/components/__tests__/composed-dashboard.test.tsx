// @vitest-environment jsdom
//
// Covers `<ComposedDashboard>` — Cinatra's assembly of drizzle-cube's
// composable dashboard pieces. The provider is REAL (so the gating logic is
// exercised against the actual `DashboardProvider`); the heavy leaf pieces
// (grid surface / modals / filter bar) are stubbed because their chart and
// modal internals are irrelevant to the assembly contract under test:
//
//   - empty dashboards render no toolbar/filter bar (the empty-state surface
//     carries its own add affordances) — mirrors upstream's back-compat
//     `<DashboardGrid>` gating;
//   - non-empty dashboards mount the Cinatra toolbar (owner labels); the
//     filter bar mounts inside `<DashboardFilterBarSlot>` — the
//     child-toolbar wrapper (design spec §Nested toolbar, cinatra#65) —
//     only when upstream's own gating would paint it (editable AND
//     (edit mode OR saved dashboard filters)).
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/composed-dashboard.test.tsx

import "./jsdom-shims";
import React, { type ComponentProps } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("drizzle-cube/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-cube/client")>();
  return {
    ...actual,
    DashboardGridSurface: () => <div data-testid="grid-surface" />,
    DashboardModals: () => <div data-testid="modals" />,
    DashboardFilterBar: () => <div data-testid="filter-bar" />,
  };
});

import { ComposedDashboard } from "../composed-dashboard";
import { DashboardsClientShell } from "../dashboards-client-shell";

afterEach(cleanup);

type Config = ComponentProps<typeof ComposedDashboard>["config"];

const EMPTY_CONFIG = {
  portlets: [],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as unknown as Config;

const ONE_PORTLET_CONFIG = {
  portlets: [
    {
      id: "p1",
      title: "Portlet one",
      x: 0,
      y: 0,
      w: 6,
      h: 4,
      chartType: "table",
      query: "{}",
      chartConfig: {},
      displayConfig: {},
    },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as unknown as Config;

describe("ComposedDashboard — assembly gating", () => {
  test("empty dashboard: no toolbar, no filter bar; surface + modals still mount", () => {
    render(<ComposedDashboard config={EMPTY_CONFIG} editable />);

    expect(
      document.querySelector("[data-cinatra-dashboard-toolbar]"),
    ).toBeNull();
    expect(screen.queryByTestId("filter-bar")).toBeNull();
    expect(screen.getByTestId("grid-surface")).toBeTruthy();
    expect(screen.getByTestId("modals")).toBeTruthy();
  });

  test("non-empty dashboard: mounts the Cinatra toolbar (owner label); filter bar stays hidden in view mode without saved filters", () => {
    render(<ComposedDashboard config={ONE_PORTLET_CONFIG} editable />);

    expect(
      document.querySelector("[data-cinatra-dashboard-toolbar]"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit dashboard" }),
    ).toBeTruthy();
    // Upstream's DashboardFilterPanel returns null here (view mode, zero
    // dashboard filters); the slot mirrors that gating so the nested-toolbar
    // wrapper never floats around an empty bar.
    expect(screen.queryByTestId("filter-bar")).toBeNull();
    expect(
      document.querySelector("[data-cinatra-dashboard-filter-bar]"),
    ).toBeNull();
    expect(screen.getByTestId("grid-surface")).toBeTruthy();
    expect(screen.getByTestId("modals")).toBeTruthy();
  });

  test("read-only non-empty dashboard renders no toolbar (no anchor, not editable)", () => {
    render(<ComposedDashboard config={ONE_PORTLET_CONFIG} editable={false} />);

    expect(
      document.querySelector("[data-cinatra-dashboard-toolbar]"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit dashboard" }),
    ).toBeNull();
  });
});

describe("ComposedDashboard — DashboardFilterBarSlot (nested-toolbar wrapper, cinatra#65)", () => {
  test("edit mode mounts the filter bar inside the child-toolbar wrapper; the toolbar tightens to the 6px stack gap", () => {
    render(<ComposedDashboard config={ONE_PORTLET_CONFIG} editable />);

    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));

    const wrapper = document.querySelector(
      "[data-cinatra-dashboard-filter-bar]",
    );
    expect(wrapper).not.toBeNull();
    // 20px child-toolbar inset (spec §Nested toolbar); the stable hook the
    // dashboard-theme.css scoped restyle targets.
    expect(wrapper?.className).toContain("ml-5");
    expect(wrapper?.querySelector("[data-testid='filter-bar']")).toBeTruthy();

    // 6px stack gap while the child bar follows.
    const toolbar = document.querySelector(
      "[data-cinatra-dashboard-toolbar]",
    );
    expect(toolbar?.className).toContain("mb-1.5");
    expect(toolbar?.className).not.toContain("mb-4");
  });

  test("dashboard filters (provider prop) surface the wrapper in view mode too", () => {
    // `dashboardFilters` is a DashboardProvider PROP (upstream does NOT
    // read config.filters back into the context) — drive that exact path.
    const dashboardFilters = [
      {
        id: "df_1",
        label: "Date Range Filter",
        isUniversalTime: true,
        filter: {
          member: "__universal_time__",
          operator: "inDateRange",
          values: ["last 30 days"],
        },
      },
    ] as unknown as ComponentProps<
      typeof ComposedDashboard
    >["dashboardFilters"];

    render(
      <ComposedDashboard
        config={ONE_PORTLET_CONFIG}
        editable
        dashboardFilters={dashboardFilters}
      />,
    );

    expect(
      document.querySelector("[data-cinatra-dashboard-filter-bar]"),
    ).not.toBeNull();
    expect(
      document
        .querySelector("[data-cinatra-dashboard-toolbar]")
        ?.className.includes("mb-1.5"),
    ).toBe(true);
  });

  test("view mode without filters keeps the regular 16px toolbar margin", () => {
    render(<ComposedDashboard config={ONE_PORTLET_CONFIG} editable />);

    const toolbar = document.querySelector(
      "[data-cinatra-dashboard-toolbar]",
    );
    expect(toolbar?.className).toContain("mb-4");
  });

  test("read-only dashboards never mount the wrapper", () => {
    render(<ComposedDashboard config={ONE_PORTLET_CONFIG} editable={false} />);

    expect(
      document.querySelector("[data-cinatra-dashboard-filter-bar]"),
    ).toBeNull();
  });
});

describe("ComposedDashboard under DashboardsClientShell — dashboardModes seam", () => {
  test("the shell's default ['grid'] suppresses the Grid/Rows toggle in edit mode", () => {
    render(
      <DashboardsClientShell>
        <ComposedDashboard config={ONE_PORTLET_CONFIG} editable />
      </DashboardsClientShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));
    expect(screen.queryByRole("button", { name: "Grid" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rows" })).toBeNull();
  });

  test("the shell's ['grid','rows'] surfaces the Grid/Rows toggle in edit mode", () => {
    render(
      <DashboardsClientShell dashboardModes={["grid", "rows"]}>
        <ComposedDashboard config={ONE_PORTLET_CONFIG} editable />
      </DashboardsClientShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));
    expect(screen.getByRole("button", { name: "Grid" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rows" })).toBeTruthy();
  });
});

describe("ComposedDashboard under DashboardsClientShell — page-anchor seam", () => {
  test("the shell's pageAnchor reaches the toolbar; the DOM satisfies the SSR-fallback-hiding selector", () => {
    // Mounts the REAL shell (page-anchor context + CubeProvider + attrs)
    // around the composition, then asserts the exact structural premise the
    // `dashboard-theme.css` `body:has(...)` rule keys on to hide the
    // server-rendered PageHeader fallback. jsdom does not apply CSS, so the
    // selector match — shell attrs wrapping the live toolbar action — is
    // the testable contract.
    render(
      <DashboardsClientShell pageAnchor="agents">
        <ComposedDashboard config={ONE_PORTLET_CONFIG} editable />
      </DashboardsClientShell>,
    );

    const liveAction = document.querySelector(
      '[data-cinatra-dashboard-shell="true"][data-cinatra-page-anchor="agents"] ' +
        '[data-cinatra-page-action="run-agent"]',
    );
    expect(liveAction).not.toBeNull();
    expect(liveAction?.getAttribute("href")).toBe("/agents/run");

    // Both route actions render inside the toolbar, in declared order.
    const anchors = [
      ...document.querySelectorAll("[data-cinatra-page-action]"),
    ].map((a) => a.getAttribute("data-cinatra-page-action"));
    expect(anchors).toEqual(["run-agent", "create-agent"]);
  });
});
