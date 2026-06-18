// @vitest-environment jsdom
//
// Real-surface render coverage for the keystone analytics portlet view
// (cinatra#325 §2a–2e). Exercises the ACTUAL CubeProvider/QueryClient shell
// (`DashboardsClientShell`) wrapping the embedded drizzle-cube grid against the
// real `AGENTS_DEFAULT_CONFIG` (the §2e acceptance fixture). The heavy DC grid
// leaves (grid surface / modals / filter bar) are stubbed exactly as
// `composed-dashboard.test.tsx` does — their chart internals are irrelevant to
// the chrome/shell contract under test; what matters is that:
//
//   - the analytics view mounts the real DC composition (provider → toolbar →
//     grid surface) for `config.dashboard`, i.e. the embedded analytics grid
//     actually renders;
//   - the CubeProvider shell is present (page-anchor attrs + a same-origin
//     CubeProvider) so the grid has its data context — #325(a);
//   - read-only by default (the embedded-extension case): no Edit affordance;
//   - the optional `pageAnchor` / `dashboardModes` forward to the shell so
//     entity screens (#328) keep their route-scoped toolbar + Grid/Rows toggle.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/analytics-portlet-view.test.tsx

import "./jsdom-shims";
import React from "react";
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

import { AnalyticsPortletView } from "../analytics-portlet-view";
import { AGENTS_DEFAULT_CONFIG } from "../seed-configs/agents-default";

afterEach(cleanup);

describe("AnalyticsPortletView — embedded drizzle-cube grid under the CubeProvider shell", () => {
  test("mounts the embedded analytics grid (real DC composition) for config.dashboard", () => {
    render(<AnalyticsPortletView dashboard={AGENTS_DEFAULT_CONFIG} />);

    // The DC grid surface + modals mount — the embedded analytics dashboard
    // renders the real drizzle-cube composition, not a placeholder.
    expect(screen.getByTestId("grid-surface")).toBeTruthy();
    expect(screen.getByTestId("modals")).toBeTruthy();
  });

  test("editable non-empty dashboard mounts the Cinatra toolbar (owner Edit affordance)", () => {
    render(<AnalyticsPortletView dashboard={AGENTS_DEFAULT_CONFIG} editable onSave={async () => {}} />);

    // Editable + non-empty → the Cinatra toolbar mounts (same gating as
    // ComposedDashboard); the grid surface still renders.
    expect(document.querySelector("[data-cinatra-dashboard-toolbar]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Edit dashboard" })).toBeTruthy();
    expect(screen.getByTestId("grid-surface")).toBeTruthy();
  });

  test("provides the CubeProvider/QueryClient shell around the grid (#325(a))", () => {
    render(<AnalyticsPortletView dashboard={AGENTS_DEFAULT_CONFIG} />);

    // DashboardsClientShell stamps the shell marker attribute and wraps the grid;
    // the grid surface lives INSIDE that shell (the data context travels with the
    // analytics view, never leaking drizzle-cube/client into the app dir).
    const shell = document.querySelector('[data-cinatra-dashboard-shell="true"]');
    expect(shell).not.toBeNull();
    expect(shell?.querySelector("[data-testid='grid-surface']")).toBeTruthy();
  });

  test("is read-only by default — no Edit affordance (the embedded-extension acceptance)", () => {
    render(<AnalyticsPortletView dashboard={AGENTS_DEFAULT_CONFIG} />);
    // No page anchor + not editable → the toolbar renders without the owner Edit
    // button (DashboardGridContainer read-only branch: ComposedDashboard editable=false).
    expect(screen.queryByRole("button", { name: "Edit dashboard" })).toBeNull();
  });

  test("forwards pageAnchor to the shell so route-scoped toolbar actions render (#328 seam)", () => {
    render(<AnalyticsPortletView dashboard={AGENTS_DEFAULT_CONFIG} editable pageAnchor="agents" />);

    const liveAction = document.querySelector(
      '[data-cinatra-dashboard-shell="true"][data-cinatra-page-anchor="agents"] ' +
        '[data-cinatra-page-action="run-agent"]',
    );
    expect(liveAction).not.toBeNull();
    expect(liveAction?.getAttribute("href")).toBe("/agents/run");
  });

  test("forwards dashboardModes — ['grid','rows'] surfaces the Grid/Rows toggle in edit mode", () => {
    render(
      <AnalyticsPortletView
        dashboard={AGENTS_DEFAULT_CONFIG}
        editable
        onSave={async () => {}}
        dashboardModes={["grid", "rows"]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));
    expect(screen.getByRole("button", { name: "Grid" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rows" })).toBeTruthy();
  });

  test("default dashboardModes (['grid']) keeps the Grid/Rows toggle hidden", () => {
    render(<AnalyticsPortletView dashboard={AGENTS_DEFAULT_CONFIG} editable onSave={async () => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));
    expect(screen.queryByRole("button", { name: "Grid" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rows" })).toBeNull();
  });
});
