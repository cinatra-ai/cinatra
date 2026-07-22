// @vitest-environment jsdom
// cinatra#1914 — a card whose query has dimensions but NO measures must still
// issue the data request (`GET <apiUrl>/load?query=…`) when mounted on the
// dashboard grid, exactly like a card with a measure does. The backend serves
// dimensions-only queries (verified on the live endpoint in the issue), and
// drizzle-cube 0.6.4's own validity gate (`useCubeLoadQuery`) accepts
// measures-OR-dimensions-OR-timeDimensions — so a silent no-fetch blank card
// is a defect wherever it creeps in.
//
// This test mounts the REAL production chain — DashboardsClientShell →
// DashboardGridContainer → ComposedDashboard → drizzle-cube's installed
// DashboardProvider/GridSurface/AnalyticsPortlet — against the installed
// drizzle-cube bundle (same philosophy as the dc-filter-bar / portlet-error
// contract tests: pin the THIRD-PARTY behavior we depend on, not a mock's).
//
// Harness notes:
//  - jsdom has no IntersectionObserver; AnalyticsPortlet lazy-gates every
//    query on `useInView` (`initialInView: false`). The stub below reports
//    every observed element as intersecting, which models the repro (the
//    card was on-screen in the viewport).
//  - fetch is stubbed: `/meta` serves a minimal agent_runs cube; `/load`
//    records the parsed query and serves one row. The assertions are about
//    WHICH requests the chain issues, not about chart pixels.
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

// drizzle-cube's theme module calls `window.matchMedia` at IMPORT time —
// the polyfill must exist before the component imports evaluate (hoisted).
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.matchMedia !== "function") {
    g.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
});

import { DashboardGridContainer } from "../dashboard-grid-container";
import { DashboardsClientShell } from "../dashboards-client-shell";

// ── Environment polyfills (jsdom) ──────────────────────────────────────────
class ImmediateIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [0];
  private readonly cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    this.cb(
      [
        {
          isIntersecting: true,
          target,
          intersectionRatio: 1,
          time: 0,
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRect: target.getBoundingClientRect(),
          rootBounds: null,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Models the live #1914 failure: the visibility signal NEVER arrives. */
class NeverIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [0];
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

// ── Fetch stub: records every dashboards-API request ───────────────────────
type RecordedRequest = { url: string; query: unknown | null };
const requests: RecordedRequest[] = [];

const CUBE_META = {
  cubes: [
    {
      name: "agent_runs",
      title: "Agent runs",
      measures: [
        {
          name: "agent_runs.count",
          title: "Count",
          shortTitle: "Count",
          type: "number",
          aggType: "count",
        },
      ],
      dimensions: [
        {
          name: "agent_runs.agent_name",
          title: "Agent name",
          shortTitle: "Agent name",
          type: "string",
        },
      ],
      segments: [],
    },
  ],
};

const LOAD_ROWS = [{ "agent_runs.agent_name": "Email Drafting Agent" }];

function installFetchStub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/meta")) {
        requests.push({ url, query: null });
        return new Response(JSON.stringify(CUBE_META), { status: 200 });
      }
      if (url.includes("/load")) {
        const q = new URL(url, "http://localhost").searchParams.get("query");
        requests.push({ url, query: q ? JSON.parse(q) : null });
        return new Response(
          JSON.stringify({
            query: q ? JSON.parse(q) : {},
            data: LOAD_ROWS,
            annotation: { measures: {}, dimensions: {}, segments: {}, timeDimensions: {} },
          }),
          { status: 200 },
        );
      }
      requests.push({ url, query: null });
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
}

// ── Portlets (the issue's persisted card, verbatim + layout fields) ────────
/** The EXACT card from cinatra#1914: dimension only, measures: [], table. */
const DIMS_ONLY_PORTLET = {
  id: "portlet-1784574031597",
  title: "das hier",
  x: 0,
  y: 0,
  w: 6,
  h: 4,
  analysisConfig: {
    version: 1,
    analysisType: "query",
    activeView: "chart",
    query: { measures: [], dimensions: ["agent_runs.agent_name"] },
    charts: {
      query: {
        chartType: "table",
        chartConfig: { xAxis: ["agent_runs.agent_name"] },
      },
    },
  },
} as const;

/** Control: identical card WITH a measure — the shape the widget path makes. */
const WITH_MEASURE_PORTLET = {
  ...DIMS_ONLY_PORTLET,
  id: "portlet-control-with-measure",
  title: "control",
  analysisConfig: {
    ...DIMS_ONLY_PORTLET.analysisConfig,
    query: {
      measures: ["agent_runs.count"],
      dimensions: ["agent_runs.agent_name"],
    },
  },
} as const;

function mountDashboard(portlet: unknown): ReturnType<typeof render> {
  const config = { portlets: [portlet] } as never;
  return render(
    <DashboardsClientShell>
      <DashboardGridContainer initialConfig={config} editable={false} />
    </DashboardsClientShell>,
  );
}

function loadRequests(): RecordedRequest[] {
  return requests.filter((r) => r.url.includes("/load"));
}

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal("IntersectionObserver", ImmediateIntersectionObserver);
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  installFetchStub();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dimensions-only card issues its load request (cinatra#1914)", () => {
  test("control: a card WITH a measure requests /load from the dashboard grid", async () => {
    mountDashboard(WITH_MEASURE_PORTLET);
    await waitFor(
      () => {
        expect(loadRequests().length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    expect(loadRequests()[0]!.query).toMatchObject({
      measures: ["agent_runs.count"],
      dimensions: ["agent_runs.agent_name"],
    });
  });

  test("a dimensions-only card (measures: []) requests /load exactly the same", async () => {
    mountDashboard(DIMS_ONLY_PORTLET);
    await waitFor(
      () => {
        expect(loadRequests().length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    expect(loadRequests()[0]!.query).toMatchObject({
      dimensions: ["agent_runs.agent_name"],
    });
  });

  // The live #1914 condition: the on-screen visibility signal NEVER fires
  // (page-load geometry). Without the eager-load injection this was DC's
  // silent forever-blank — only /meta on the wire, never /load. The grid
  // container's `eagerLoad` injection (cinatra#1914) must make the card
  // fetch anyway.
  test("dims-only card still requests /load when the visibility signal never fires", async () => {
    vi.stubGlobal("IntersectionObserver", NeverIntersectionObserver);
    mountDashboard(DIMS_ONLY_PORTLET);
    await waitFor(
      () => {
        expect(loadRequests().length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    expect(loadRequests()[0]!.query).toMatchObject({
      dimensions: ["agent_runs.agent_name"],
    });
  });

  // Boundary (codex round-0): DC resolves `portlet.eagerLoad ??
  // config.eagerLoad ?? false` — an explicit per-portlet `false` is an
  // authored lazy opt-out and must KEEP deferring behind the visibility
  // signal even though the container injects the config-level flag. This
  // pins the precedence so a later change can't silently widen the fix.
  test("a portlet with an explicit eagerLoad:false opt-out stays lazy", async () => {
    vi.stubGlobal("IntersectionObserver", NeverIntersectionObserver);
    mountDashboard({ ...DIMS_ONLY_PORTLET, eagerLoad: false });
    // Deterministic settle: give the chain the same window the positive
    // tests need to issue /load (meta fires immediately; load never should).
    await waitFor(() => expect(requests.length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(loadRequests()).toEqual([]);
  });
});
