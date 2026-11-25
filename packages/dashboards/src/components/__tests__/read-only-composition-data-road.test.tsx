// @vitest-environment jsdom
//
// THE DATA ROAD INTO THE PROMOTED READ-ONLY COMPOSITION (cinatra#3092, epic
// #3087). The plan: "The series are live, fetched under a short-lived data
// capability sealed to the actor". A display in the dashboard extension draws
// through the SAME composition the application draws with, but it does not sit
// inside the application's dashboards shell — so, given a data road, each
// promoted view mounts its own query client and cube provider over it; without
// one it renders exactly what it renders today (the host's own read-only
// surface, inside the shell that already mounts both).
//
// `drizzle-cube/client` is substituted by a RECORDING module (the shape of
// composed-dashboard.test.tsx): the cube provider and the dashboard provider
// record the props they were mounted with, and the grid surface records
// whether a query client is reachable from where it sits.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/read-only-composition-data-road.test.tsx

import "./jsdom-shims";
import React, { type ReactNode } from "react";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";

const rec = vi.hoisted(() => ({
  cube: [] as Record<string, unknown>[],
  dashboard: [] as Record<string, unknown>[],
  gridSawQueryClient: [] as boolean[],
}));

function withoutChildren(props: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...props };
  delete rest.children;
  return rest;
}

vi.mock("drizzle-cube/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-cube/client")>();
  return {
    ...actual,
    CubeProvider: (props: { children?: ReactNode } & Record<string, unknown>) => {
      rec.cube.push(withoutChildren(props));
      return <div data-testid="cube-provider">{props.children}</div>;
    },
    DashboardProvider: (props: { children?: ReactNode } & Record<string, unknown>) => {
      rec.dashboard.push(withoutChildren(props));
      return <div data-testid="dashboard-provider">{props.children}</div>;
    },
    DashboardGridSurface: () => {
      let saw = true;
      try {
        useQueryClient();
      } catch {
        saw = false;
      }
      rec.gridSawQueryClient.push(saw);
      return <div data-testid="grid-surface" />;
    },
  };
});

import {
  ReadOnlyComposedDashboard,
  ReadOnlySinglePortlet,
} from "@cinatra-ai/sdk-dashboard/components";

afterEach(() => {
  cleanup();
  rec.cube.length = 0;
  rec.dashboard.length = 0;
  rec.gridSawQueryClient.length = 0;
});

// What this file substituted, it hands back: the package's full run stays
// unaffected by the recording module.
afterAll(() => {
  vi.doUnmock("drizzle-cube/client");
  vi.resetModules();
});

const CONFIG = {
  portlets: [
    { id: "p1", title: "Portlet one", x: 0, y: 0, w: 6, h: 4, chartType: "table", query: "{}" },
    { id: "p2", title: "Portlet two", x: 6, y: 0, w: 6, h: 4, chartType: "table", query: "{}" },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as never;

const ROAD = { road: "session" as const, apiUrl: "/api/dashboards/cubejs-api/v1" };

// Typed loosely so this file reads the same before the views name the prop.
const Dashboard = ReadOnlyComposedDashboard as unknown as (p: Record<string, unknown>) => React.JSX.Element;
const Portlet = ReadOnlySinglePortlet as unknown as (p: Record<string, unknown>) => React.JSX.Element;

describe("given a data road, each promoted view mounts its own query client and cube provider over it", () => {
  test("(c1) the read-only dashboard", () => {
    render(<Dashboard config={CONFIG} dataRoad={ROAD} />);
    expect(rec.cube).toHaveLength(1);
    expect(rec.cube[0]?.apiOptions).toEqual({ apiUrl: ROAD.apiUrl, credentials: "include" });
    expect(rec.gridSawQueryClient).toEqual([true]);
    // The road is the composition's, never a prop the dashboard provider is handed.
    expect(rec.dashboard).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(rec.dashboard[0], "dataRoad")).toBe(false);
    expect(rec.dashboard[0]?.editable).toBe(false);
    expect(screen.getByTestId("grid-surface")).toBeTruthy();
  });

  test("(c1) the single portlet", () => {
    render(<Portlet config={CONFIG} portletId="p2" dataRoad={ROAD} />);
    expect(rec.cube).toHaveLength(1);
    expect(rec.cube[0]?.apiOptions).toEqual({ apiUrl: ROAD.apiUrl, credentials: "include" });
    expect(rec.gridSawQueryClient).toEqual([true]);
    expect(rec.dashboard).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(rec.dashboard[0], "dataRoad")).toBe(false);
    expect(rec.dashboard[0]?.editable).toBe(false);
    expect((rec.dashboard[0]?.config as { portlets: { id: string }[] }).portlets.map((p) => p.id)).toEqual(["p2"]);
  });
});

describe("without a road, each view renders exactly what it renders today", () => {
  test("(c2) the read-only dashboard mounts no provider of its own and the same provider props", () => {
    render(<Dashboard config={CONFIG} />);
    expect(rec.cube).toHaveLength(0);
    expect(rec.gridSawQueryClient).toEqual([false]);
    expect(rec.dashboard).toEqual([{ config: CONFIG, editable: false }]);
    expect(document.querySelector('[data-cinatra-read-only-composition="dashboard"]')).not.toBeNull();
  });

  test("(c2) the single portlet mounts no provider of its own and the same provider props", () => {
    render(<Portlet config={CONFIG} portletId="p1" />);
    expect(rec.cube).toHaveLength(0);
    expect(rec.gridSawQueryClient).toEqual([false]);
    expect(rec.dashboard).toHaveLength(1);
    expect(Object.keys(rec.dashboard[0] ?? {}).sort()).toEqual(["config", "editable"]);
    expect(rec.dashboard[0]?.editable).toBe(false);
    expect((rec.dashboard[0]?.config as { portlets: { id: string }[] }).portlets.map((p) => p.id)).toEqual(["p1"]);
    expect(document.querySelector('[data-cinatra-read-only-composition="single-portlet"]')).not.toBeNull();
  });
});
