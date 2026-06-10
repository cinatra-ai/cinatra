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
//   - non-empty dashboards mount the Cinatra toolbar (owner labels) and the
//     filter bar.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/composed-dashboard.test.tsx

import "./jsdom-shims";
import React, { type ComponentProps } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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

  test("non-empty dashboard: mounts the Cinatra toolbar (owner label) and filter bar", () => {
    render(<ComposedDashboard config={ONE_PORTLET_CONFIG} editable />);

    expect(
      document.querySelector("[data-cinatra-dashboard-toolbar]"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit dashboard" }),
    ).toBeTruthy();
    expect(screen.getByTestId("filter-bar")).toBeTruthy();
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
