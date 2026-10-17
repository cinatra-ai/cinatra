// @vitest-environment jsdom
//
// THE NO-SERIES ROAD OF THE PROMOTED READ-ONLY COMPOSITION (cinatra#3092). A
// reading that holds no series draws the dashboard's chrome, titles and layout,
// with no numbers. Given `{ road: "none" }`, the composition mounts its providers
// over a query client on which no query runs: drizzle-cube's OWN grid lays the
// portlets out by the configuration's `grid`, `layoutMode` and `rows`, and
// nothing is fetched.
//
// Unlike read-only-composition-data-road.test.tsx, nothing of drizzle-cube is
// substituted here: the layout is the real grid's. `fetch` is a recording stub,
// and IntersectionObserver reports every portlet as visible, so a portlet that
// would load does load.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/read-only-composition-no-series-road.test.tsx

import "./jsdom-shims";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ReadOnlyComposedDashboard } from "@cinatra-ai/sdk-dashboard/components";

// Typed loosely so this file reads the same before the road admits `none`.
const Dashboard = ReadOnlyComposedDashboard as unknown as (p: Record<string, unknown>) => React.JSX.Element;

const NONE = { road: "none" } as const;
const QUERY = JSON.stringify({ measures: ["Items.count"] });
const PORTLETS = [
  { id: "p1", title: "Portlet one", x: 0, y: 0, w: 6, h: 3, chartType: "kpiNumber", query: QUERY },
  { id: "p2", title: "Portlet two", x: 6, y: 0, w: 6, h: 3, chartType: "table", query: QUERY },
  { id: "p3", title: "Portlet three", x: 0, y: 3, w: 12, h: 2, chartType: "bar", query: QUERY },
];

function gridConfig(rowHeight: number) {
  return { portlets: PORTLETS, layoutMode: "grid", grid: { cols: 12, rowHeight, minW: 2, minH: 2 } };
}

const ROWS_CONFIG = {
  portlets: PORTLETS,
  layoutMode: "rows",
  grid: { cols: 12, rowHeight: 80, minW: 2, minH: 2 },
  rows: [
    { id: "r1", h: 3, columns: [{ portletId: "p3", w: 12 }] },
    { id: "r2", h: 3, columns: [{ portletId: "p2", w: 6 }, { portletId: "p1", w: 6 }] },
  ],
};

class VisibleObserver {
  constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {}
  observe(target: Element) {
    this.callback([{ isIntersecting: true, intersectionRatio: 1, target }], this);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const fetched: string[] = [];

beforeEach(() => {
  fetched.length = 0;
  vi.stubGlobal("IntersectionObserver", VisibleObserver);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      fetched.push(String(input));
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Past the grid's query debounce, so a query that would run has run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

function heightsOf(container: HTMLElement, selector: string): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).map((el) => el.style.height);
}

describe("the no-series road lays the dashboard out with the real grid and fetches nothing (cinatra#3092)", () => {
  test("(n1) draws every portlet's title and makes no network call, even when a portlet is refreshed", async () => {
    render(<Dashboard config={gridConfig(80)} dataRoad={NONE} />);
    await settle();
    for (const title of ["Portlet one", "Portlet two", "Portlet three"]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    for (const refresh of screen.queryAllByTitle(/^Refresh portlet data/)) {
      fireEvent.click(refresh);
    }
    await settle();
    expect(fetched).toEqual([]);
  });

  test("(n2) two configurations that differ only in grid.rowHeight (80 vs 160) draw different row sizing", async () => {
    const short = render(<Dashboard config={gridConfig(80)} dataRoad={NONE} />);
    await settle();
    // rowHeight * h + margin * (h - 1): the grid's own arithmetic, read from what it drew.
    expect(heightsOf(short.container, ".react-grid-layout")).toEqual(["464px"]);
    expect(heightsOf(short.container, ".react-grid-item")).toEqual(["272px", "272px", "176px"]);
    short.unmount();

    const tall = render(<Dashboard config={gridConfig(160)} dataRoad={NONE} />);
    await settle();
    expect(heightsOf(tall.container, ".react-grid-layout")).toEqual(["864px"]);
    expect(heightsOf(tall.container, ".react-grid-item")).toEqual(["512px", "512px", "336px"]);
    expect(fetched).toEqual([]);
  });

  test("(n3) a layoutMode 'rows' configuration places its portlets by its rows", async () => {
    const { container } = render(<Dashboard config={ROWS_CONFIG} dataRoad={NONE} />);
    await settle();
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".dc-row-layout-row"));
    expect(rows.map((row) => row.style.height)).toEqual(["240px", "240px"]);
    expect(
      rows.map((row) =>
        Array.from(row.querySelectorAll<HTMLElement>(".dc-row-layout-column-wrapper")).map(
          (column) => column.dataset.portletId,
        ),
      ),
    ).toEqual([["p3"], ["p2", "p1"]]);
    expect(container.querySelector(".react-grid-layout")).toBeNull();
    expect(fetched).toEqual([]);
  });
});
