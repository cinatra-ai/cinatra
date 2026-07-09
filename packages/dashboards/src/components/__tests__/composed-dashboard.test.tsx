// @vitest-environment jsdom
//
// Covers `<ComposedDashboard>` — Cinatra's assembly of drizzle-cube's
// composable dashboard pieces. The provider is REAL (so the gating logic is
// exercised against the actual `DashboardProvider`); the heavy leaf pieces
// (grid surface / modals / filter bar) are stubbed because their chart and
// modal internals are irrelevant to the assembly contract under test:
//
//   - empty dashboards keep the grey toolbar frame mounted and swap
//     drizzle-cube's raw "No Portlets" placeholder for the app-consistent
//     `<DashboardEmptyState>` (cinatra#1119); an editable empty surface
//     carries the "Add card" primary action, a read-only one shows the
//     message alone; the filter bar stays hidden while empty;
//   - non-empty dashboards mount the Cinatra toolbar (owner labels) and the
//     real grid surface; the filter bar mounts inside
//     `<DashboardFilterBarSlot>` — the child-toolbar wrapper (design spec
//     §Nested toolbar, cinatra#65) — only when upstream's own gating would
//     paint it (editable AND (edit mode OR saved dashboard filters)).
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
  test("empty editable dashboard: keeps the toolbar, swaps the raw grid placeholder for the app empty state (with Add-card CTA); filter bar hidden; modals mount (cinatra#1119)", () => {
    render(<ComposedDashboard config={EMPTY_CONFIG} editable />);

    // The grey toolbar frame stays mounted on an empty surface (owner label),
    // so an empty dashboard reads as the same surface type as its peers.
    expect(
      document.querySelector("[data-cinatra-dashboard-toolbar]"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit dashboard" }),
    ).toBeTruthy();

    // The app empty state replaces drizzle-cube's raw "No Portlets" screen:
    // the (stubbed) grid surface must NOT mount while empty.
    expect(screen.getByTestId("dashboard-empty-state")).toBeTruthy();
    expect(screen.queryByTestId("grid-surface")).toBeNull();

    // Single primary action, wired to the same add-portlet handler the
    // toolbar uses (app design spec: an empty state always carries one).
    expect(screen.getByRole("button", { name: "Add card" })).toBeTruthy();

    // No filter bar while empty; modals always mount.
    expect(screen.queryByTestId("filter-bar")).toBeNull();
    expect(
      document.querySelector("[data-cinatra-dashboard-filter-bar]"),
    ).toBeNull();
    expect(screen.getByTestId("modals")).toBeTruthy();
  });

  test("empty read-only dashboard: app empty state with NO add affordance; toolbar self-hides; grid surface stays swapped out", () => {
    render(<ComposedDashboard config={EMPTY_CONFIG} editable={false} />);

    expect(screen.getByTestId("dashboard-empty-state")).toBeTruthy();
    expect(screen.queryByTestId("grid-surface")).toBeNull();
    // Read-only surface with no route actions: the toolbar renders nothing,
    // and the empty state offers no add button.
    expect(
      document.querySelector("[data-cinatra-dashboard-toolbar]"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Add card" })).toBeNull();
  });

  test("the empty-state Add-card CTA opens the add-portlet picker without prematurely swapping in the grid surface", () => {
    render(<ComposedDashboard config={EMPTY_CONFIG} editable />);

    // Starts on the app empty state (no real grid surface).
    expect(screen.getByTestId("dashboard-empty-state")).toBeTruthy();
    expect(screen.queryByTestId("grid-surface")).toBeNull();

    // The CTA opens the add-portlet modal via the SAME handler the toolbar
    // uses — it must not throw, and (since no card is committed yet) the empty
    // state stays put and the grid surface does NOT swap in. The full
    // add-card → live-count-flip → grid-surface transition is exercised on the
    // real surface in tests/e2e/dashboards/personal.spec.ts.
    fireEvent.click(screen.getByRole("button", { name: "Add card" }));
    expect(screen.getByTestId("dashboard-empty-state")).toBeTruthy();
    expect(screen.queryByTestId("grid-surface")).toBeNull();
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
    // cinatra#1007: /agents/run removed (not redirected) — the run-agent
    // picker moved to /agents.
    expect(liveAction?.getAttribute("href")).toBe("/agents");

    // Both route actions render inside the toolbar, in declared order.
    const anchors = [
      ...document.querySelectorAll("[data-cinatra-page-action]"),
    ].map((a) => a.getAttribute("data-cinatra-page-action"));
    expect(anchors).toEqual(["run-agent", "create-agent"]);
  });
});
