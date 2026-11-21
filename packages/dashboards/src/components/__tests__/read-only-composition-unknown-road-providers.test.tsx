// @vitest-environment jsdom
//
// AN UNKNOWN DATA ROAD MOUNTS NO PROVIDER (cinatra#3092, #4118 fold, MUST-FIX 2).
// The composition admits exactly `{ road: "none" }` and `{ road: "session",
// apiUrl }`, by equality. Any other value — a missing, malformed, case-varied or
// future road, or a value that is not a road object at all — is refused: no cube
// provider (so never the session provider, which sends the reader's
// credentials), no dashboard provider, no grid, and a settled visible refusal.
//
// `drizzle-cube/client` is substituted by the same RECORDING module as
// read-only-composition-data-road.test.tsx: each provider records the props it
// was mounted with.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/read-only-composition-unknown-road-providers.test.tsx

import "./jsdom-shims";
import React, { type ReactNode } from "react";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { API, REFUSED_ROADS, SAME_ORIGIN_API } from "./read-only-composition-road-fixtures";

const rec = vi.hoisted(() => ({
  cube: [] as Record<string, unknown>[],
  dashboard: [] as Record<string, unknown>[],
  grid: 0,
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
      rec.grid += 1;
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
  rec.grid = 0;
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
};

// Typed loosely so this file reads the same against any version of the props.
const Dashboard = ReadOnlyComposedDashboard as unknown as (p: Record<string, unknown>) => React.JSX.Element;
const Portlet = ReadOnlySinglePortlet as unknown as (p: Record<string, unknown>) => React.JSX.Element;

const REFUSAL = '[role="alert"][data-cinatra-read-only-composition-refused="data-road"]';

function expectRefusedWithNoProvider() {
  // Never the session provider: no cube provider mounts at all ...
  expect(rec.cube.filter((props) => (props.apiOptions as { credentials?: string } | undefined)?.credentials === "include")).toEqual([]);
  expect(rec.cube).toEqual([]);
  expect(rec.dashboard).toEqual([]);
  expect(rec.grid).toBe(0);
  const refusals = document.querySelectorAll(REFUSAL);
  expect(refusals).toHaveLength(1);
  expect(refusals[0]?.textContent).toBe(
    "This view cannot be drawn: its data road is not one this composition knows.",
  );
}

describe("an unknown data road mounts no provider and draws a settled refusal (cinatra#3092 fold, MF2)", () => {
  test.each(REFUSED_ROADS)("(u1) the read-only dashboard refuses %s", (_name, dataRoad) => {
    render(<Dashboard config={CONFIG} dataRoad={dataRoad} />);
    expectRefusedWithNoProvider();
  });

  test.each(REFUSED_ROADS)("(u2) the single portlet refuses %s", (_name, dataRoad) => {
    render(<Portlet config={CONFIG} portletId="p1" dataRoad={dataRoad} />);
    expectRefusedWithNoProvider();
  });
});

describe("the two named roads are still admitted (cinatra#3092 fold, MF2; guards, green at the base too)", () => {
  test("(u3) road session with a root-relative address mounts the session provider over it, resolved against the page's own origin", () => {
    render(<Dashboard config={CONFIG} dataRoad={{ road: "session", apiUrl: API }} />);
    expect(rec.cube).toHaveLength(1);
    expect(rec.cube[0]?.apiOptions).toEqual({ apiUrl: SAME_ORIGIN_API, credentials: "include" });
    expect(rec.dashboard).toHaveLength(1);
    expect(document.querySelectorAll(REFUSAL)).toHaveLength(0);
  });

  test("[guard] (u5) road session with an absolute address of the page's own origin mounts the session provider over it", () => {
    render(<Portlet config={CONFIG} portletId="p1" dataRoad={{ road: "session", apiUrl: SAME_ORIGIN_API }} />);
    expect(rec.cube).toHaveLength(1);
    expect(rec.cube[0]?.apiOptions).toEqual({ apiUrl: SAME_ORIGIN_API, credentials: "include" });
    expect(rec.dashboard).toHaveLength(1);
    expect(document.querySelectorAll(REFUSAL)).toHaveLength(0);
  });

  test("[guard] (u4) road none mounts the no-series provider, which sends no credentials", () => {
    render(<Portlet config={CONFIG} portletId="p2" dataRoad={{ road: "none" }} />);
    expect(rec.cube).toHaveLength(1);
    expect(rec.cube[0]?.apiOptions).toEqual({ credentials: "omit" });
    expect(rec.dashboard).toHaveLength(1);
    expect(document.querySelectorAll(REFUSAL)).toHaveLength(0);
  });
});
