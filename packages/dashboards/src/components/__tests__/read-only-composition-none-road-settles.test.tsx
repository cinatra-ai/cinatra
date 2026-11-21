// @vitest-environment jsdom
//
// THE NO-SERIES ROAD SETTLES (cinatra#3092, #4118 fold, MUST-FIX 1). On road
// `none`, a CONFIGURED portlet must reach its empty state — the chart's own "No
// data available" — and must never sit behind drizzle-cube's `role="status"`
// `aria-label="Loading"` spinner. drizzle-cube 0.6.6 renders that spinner for a
// parsed query that holds neither a result nor an error
// (components/analyticsPortlet/portletRenderState.ts:74), so a query client
// whose queries never answer loads forever.
//
// Nothing of drizzle-cube is substituted: the real grid, the real portlets, the
// real charts. `fetch` is a recording stub that must never be called.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/read-only-composition-none-road-settles.test.tsx

import "./jsdom-shims";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ReadOnlyComposedDashboard, ReadOnlySinglePortlet } from "@cinatra-ai/sdk-dashboard/components";

import {
  API,
  CONFIGURED,
  CONFIGURED_PORTLETS,
  recordingFetch,
  VisibleObserver,
  type FetchCall,
} from "./read-only-composition-road-fixtures";

// Typed loosely so this file reads the same against any version of the props.
const Dashboard = ReadOnlyComposedDashboard as unknown as (p: Record<string, unknown>) => React.JSX.Element;
const Portlet = ReadOnlySinglePortlet as unknown as (p: Record<string, unknown>) => React.JSX.Element;

const NONE = { road: "none" } as const;
const EMPTY = "No data available";
const SETTLE_TIMEOUT_MS = 15_000;

const calls: FetchCall[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("IntersectionObserver", VisibleObserver);
  vi.stubGlobal("fetch", vi.fn(recordingFetch(calls)));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function loadingSpinners(): Element[] {
  return Array.from(document.querySelectorAll('[role="status"][aria-label="Loading"]'));
}

/** Waits until every expected portlet shows its empty state and none loads. */
async function expectSettledEmpty(count: number) {
  await waitFor(
    () => {
      expect(loadingSpinners()).toHaveLength(0);
      expect(screen.getAllByText(EMPTY)).toHaveLength(count);
    },
    { timeout: SETTLE_TIMEOUT_MS },
  );
}

/** Past drizzle-cube's query debounce, so a query that would run has run. */
async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

describe("on road none, a configured portlet settles to its empty state (cinatra#3092 fold, MF1)", () => {
  test("(s1) the read-only dashboard: every configured portlet shows its empty state, none loads, nothing is fetched", async () => {
    render(<Dashboard config={CONFIGURED} dataRoad={NONE} />);
    await expectSettledEmpty(CONFIGURED_PORTLETS.length);
    for (const portlet of CONFIGURED_PORTLETS) {
      expect(screen.getByText(portlet.title)).toBeTruthy();
    }
    await pause();
    expect(loadingSpinners()).toHaveLength(0);
    expect(screen.getAllByText(EMPTY)).toHaveLength(CONFIGURED_PORTLETS.length);
    expect(calls).toEqual([]);
  });

  test("(s2) the read-only dashboard: a refresh, plain and cache-busting, leaves every portlet settled and fetches nothing", async () => {
    render(<Dashboard config={CONFIGURED} dataRoad={NONE} />);
    await expectSettledEmpty(CONFIGURED_PORTLETS.length);
    const refreshes = screen.getAllByTitle(/^Refresh portlet data/);
    expect(refreshes).toHaveLength(CONFIGURED_PORTLETS.length);
    for (const refresh of refreshes) fireEvent.click(refresh);
    await pause();
    await expectSettledEmpty(CONFIGURED_PORTLETS.length);
    for (const refresh of refreshes) fireEvent.click(refresh, { shiftKey: true });
    await pause();
    await expectSettledEmpty(CONFIGURED_PORTLETS.length);
    expect(calls).toEqual([]);
  });

  test("(s3) the single portlet: the named portlet shows its empty state, does not load, and nothing is fetched", async () => {
    render(<Portlet config={CONFIGURED} portletId="p3" dataRoad={NONE} />);
    await expectSettledEmpty(1);
    expect(screen.getByText("Portlet three")).toBeTruthy();
    expect(screen.queryByText("Portlet one")).toBeNull();
    await pause();
    expect(loadingSpinners()).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  test("(s4) a none road that also carries an address still reads no address and settles", async () => {
    render(<Dashboard config={CONFIGURED} dataRoad={{ road: "none", apiUrl: API }} />);
    await expectSettledEmpty(CONFIGURED_PORTLETS.length);
    await pause();
    expect(calls).toEqual([]);
  });
});
