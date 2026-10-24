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
// would load does load. n1 reads the road's query client as the providers mount
// it (a spy on QueryClient.prototype.mount that calls through), so it can run
// every query the grid holds and read who answers it.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/read-only-composition-no-series-road.test.tsx

import "./jsdom-shims";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, type Query } from "@tanstack/react-query";

import { ReadOnlyComposedDashboard } from "@cinatra-ai/sdk-dashboard/components";

import { CONFIGURED, CONFIGURED_PORTLETS } from "./read-only-composition-road-fixtures";

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

const EMPTY = "No data available";
const UNKNOWN_QUERY = "The no-series road answers no such query.";

/** The empty answer of each family the road knows, but `load` (a result set
 *  with functions, read field by field below). */
const EMPTY_ANSWERS: Readonly<Record<string, unknown>> = {
  multiLoad: { data: [], resultSets: [], perQueryData: [], errors: [], firstError: null },
  funnel: { rawData: [], executionTime: 0, cacheInfo: undefined },
  flow: { rawData: [], executionTime: 0, cacheInfo: undefined },
  retention: { rawData: [], executionTime: 0, cacheInfo: undefined },
  meta: { meta: { cubes: [] }, labelMap: {} },
};

function loadingSpinners(): Element[] {
  return Array.from(document.querySelectorAll('[role="status"][aria-label="Loading"]'));
}

/** The one query client the providers mounted: the no-series road's own (a cube
 *  query on it is off). */
function theRoadsClient(mounted: readonly unknown[]): QueryClient {
  const clients = [...new Set(mounted)] as QueryClient[];
  expect(clients).toHaveLength(1);
  const client = clients[0] as QueryClient;
  expect(client.defaultQueryOptions({ queryKey: ["cube", "load", "probe"] }).enabled).toBe(false);
  return client;
}

/** A query that ran its function on the road: a family the road knows holds
 *  that family's empty answer from a fetch that ran; any other query holds the
 *  road's refusal. */
function expectTheRoadsAnswer(query: Query) {
  const [scope, family] = query.queryKey;
  const name = JSON.stringify(query.queryKey);
  if (scope === "cube" && family === "load") {
    expect(query.state.status, name).toBe("success");
    expect(query.state.dataUpdateCount, name).toBeGreaterThan(0);
    const set = query.state.data as { loadResponse: unknown; rawData: () => unknown[] };
    expect(set.loadResponse, name).toEqual({ data: [], annotation: {} });
    expect(set.rawData(), name).toEqual([]);
  } else if (scope === "cube" && typeof family === "string" && Object.hasOwn(EMPTY_ANSWERS, family)) {
    expect(query.state.status, name).toBe("success");
    expect(query.state.dataUpdateCount, name).toBeGreaterThan(0);
    expect(query.state.data, name).toEqual(EMPTY_ANSWERS[family]);
  } else {
    expect(query.state.status, name).toBe("error");
    expect(query.state.error?.message, name).toBe(UNKNOWN_QUERY);
  }
}

describe("the no-series road lays the dashboard out with the real grid and fetches nothing (cinatra#3092)", () => {
  test("(n1) draws every portlet's title and makes no network call, even when each portlet is refreshed", async () => {
    const mount = vi.spyOn(QueryClient.prototype, "mount");
    try {
      // CONFIGURED portlets each draw a refresh control, so the refresh is read:
      // the test fails if there is none to click.
      render(<Dashboard config={CONFIGURED} dataRoad={NONE} />);
      await settle();
      for (const portlet of CONFIGURED_PORTLETS) {
        expect(screen.getByText(portlet.title)).toBeTruthy();
      }
      const refreshes = await waitFor(
        () => {
          const found = screen.getAllByTitle(/^Refresh portlet data/);
          expect(found).toHaveLength(CONFIGURED_PORTLETS.length);
          return found;
        },
        { timeout: 15_000 },
      );
      for (const refresh of refreshes) fireEvent.click(refresh);
      await settle();
      for (const refresh of refreshes) fireEvent.click(refresh, { shiftKey: true });
      await settle();
      expect(fetched).toEqual([]);

      // The clicks above run no query function: every query on this road is off,
      // and these portlets' refresh only invalidates or removes their query. A
      // refresh through the query's observer (drizzle-cube 0.6.6's flow, funnel
      // and retention portlets refetch so) runs the query's function even when
      // the query is off. So each query the grid now holds is refetched that way:
      // its function must be the road's own, which answers the family's empty
      // answer and sends no request, never the grid's own, which fetches.
      const queries = theRoadsClient(mount.mock.contexts).getQueryCache().getAll();
      expect(queries.filter((query) => query.queryKey[0] === "cube" && query.queryKey[1] === "load").length).toBeGreaterThan(0);
      await act(async () => {
        for (const query of queries) {
          const [observer] = query.observers;
          if (observer) await observer.refetch();
          else await query.fetch().catch(() => undefined);
        }
      });
      expect(fetched).toEqual([]);
      for (const query of queries) expectTheRoadsAnswer(query);
      // What the portlets draw from those answers: each its empty state, none loads.
      await waitFor(
        () => {
          expect(loadingSpinners()).toHaveLength(0);
          expect(screen.getAllByText(EMPTY)).toHaveLength(CONFIGURED_PORTLETS.length);
        },
        { timeout: 15_000 },
      );
      expect(fetched).toEqual([]);
    } finally {
      mount.mockRestore();
    }
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
