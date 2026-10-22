// ON THE SERVER THE SESSION ROAD WAITS FOR THE PAGE'S ORIGIN (cinatra#3092,
// #4118). The composition resolves the session road's address once, against the
// page's own origin, which only the browser knows. A server render (no window)
// therefore draws a session road whose address is shaped like one as a neutral
// pending placeholder: no provider mounts, so no address is handed on, and no
// refusal is drawn, because the client that hydrates this markup draws the same
// placeholder first (read-only-composition-address-hydration.test.tsx). The
// server reads no window at all: a stand-in window, whatever its origin, does not
// change the server's markup. A value that cannot be an address is refused on
// the server at once, and the `none` road is drawn, over no address.
//
// This file runs in the package's default `node` environment and renders with
// `react-dom/server`. `drizzle-cube/client` is substituted by a RECORDING module
// of the three components the composition mounts.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/read-only-composition-address-no-window.test.tsx

import React, { type ReactNode } from "react";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const rec = vi.hoisted(() => ({ cube: [] as Record<string, unknown>[], dashboard: 0 }));

vi.mock("drizzle-cube/client", () => ({
  CubeProvider: (props: { children?: ReactNode } & Record<string, unknown>) => {
    const rest = { ...props };
    delete rest.children;
    rec.cube.push(rest);
    return <div data-testid="cube-provider">{props.children}</div>;
  },
  DashboardProvider: (props: { children?: ReactNode }) => {
    rec.dashboard += 1;
    return <div data-testid="dashboard-provider">{props.children}</div>;
  },
  DashboardGridSurface: () => <div data-testid="grid-surface" />,
}));

import { ReadOnlyComposedDashboard, ReadOnlySinglePortlet } from "@cinatra-ai/sdk-dashboard/components";

afterEach(() => {
  vi.unstubAllGlobals();
  rec.cube.length = 0;
  rec.dashboard = 0;
});

// What this file substituted, it hands back: the package's full run stays
// unaffected by the recording module.
afterAll(() => {
  vi.doUnmock("drizzle-cube/client");
  vi.resetModules();
});

const API = "/api/dashboards/cubejs-api/v1";
const CONFIG = {
  portlets: [{ id: "p1", title: "Portlet one", x: 0, y: 0, w: 6, h: 4, chartType: "table", query: "{}" }],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};
const REFUSAL = 'data-cinatra-read-only-composition-refused="data-road"';
const PENDING = '<div aria-busy="true" data-cinatra-read-only-composition-pending="data-road"></div>';

// Typed loosely so this file reads the same against any version of the props.
const Dashboard = ReadOnlyComposedDashboard as unknown as (p: Record<string, unknown>) => React.JSX.Element;
const Portlet = ReadOnlySinglePortlet as unknown as (p: Record<string, unknown>) => React.JSX.Element;

function drawDashboard(apiUrl: string): string {
  return renderToStaticMarkup(<Dashboard config={CONFIG} dataRoad={{ road: "session", apiUrl }} />);
}

function drawPortlet(apiUrl: string): string {
  return renderToStaticMarkup(<Portlet config={CONFIG} portletId="p1" dataRoad={{ road: "session", apiUrl }} />);
}

/** Pending: the placeholder and nothing else; no provider, so no address, and no refusal. */
function expectPending(markup: string) {
  expect(rec.cube).toEqual([]);
  expect(rec.dashboard).toBe(0);
  expect(markup).toBe(PENDING);
  expect(markup).not.toContain(REFUSAL);
}

function expectRefused(markup: string) {
  expect(rec.cube).toEqual([]);
  expect(rec.dashboard).toBe(0);
  expect(markup).toContain(REFUSAL);
}

describe("with no window the session road is drawn pending: no provider, no address, no refusal (#4118)", () => {
  test("[guard] (w0) this file runs where there is no window", () => {
    expect(typeof window).toBe("undefined");
  });

  test("(w1) a root-relative path is drawn pending and reaches no provider", () => {
    expectPending(drawDashboard(API));
  });

  test("(w2) the single portlet: a root-relative path is drawn pending and reaches no provider", () => {
    expectPending(drawPortlet(API));
  });

  test("(w3) an absolute URL is drawn pending and reaches no provider", () => {
    expectPending(drawDashboard(`http://localhost:3000${API}`));
  });

  test("[guard] (w4) the none road is still drawn, over no address", () => {
    const markup = renderToStaticMarkup(<Dashboard config={CONFIG} dataRoad={{ road: "none" }} />);
    expect(rec.cube).toHaveLength(1);
    expect(rec.cube[0]?.apiOptions).toEqual({ credentials: "omit" });
    expect(markup).not.toContain(REFUSAL);
  });

  test("[guard] (w5) a value that cannot be an address is refused on the server at once", () => {
    expectRefused(drawDashboard("//evil.example/cubejs-api/v1"));
  });

  test("[guard] (w6) an unknown road is refused on the server at once", () => {
    const markup = renderToStaticMarkup(<Portlet config={CONFIG} portletId="p1" dataRoad={{ road: "Session", apiUrl: API }} />);
    expectRefused(markup);
  });
});

describe("the server reads no window: a stand-in window of any origin leaves the session road pending (#4118)", () => {
  test("(o1) an opaque \"null\" origin: a root-relative path is drawn pending and reaches no provider", () => {
    vi.stubGlobal("window", { location: { origin: "null" } });
    expectPending(drawDashboard(API));
  });

  test("(o2) an opaque \"null\" origin: an absolute URL is drawn pending and reaches no provider", () => {
    vi.stubGlobal("window", { location: { origin: "null" } });
    expectPending(drawPortlet(`http://localhost:3000${API}`));
  });

  test("(o3) an empty origin: a root-relative path is drawn pending and reaches no provider", () => {
    vi.stubGlobal("window", { location: { origin: "" } });
    expectPending(drawDashboard(API));
  });

  test("(o4) a window with no location: a root-relative path is drawn pending and reaches no provider", () => {
    vi.stubGlobal("window", {});
    expectPending(drawDashboard(API));
  });

  test("(o5) a window whose location read throws: a root-relative path is drawn pending and reaches no provider", () => {
    vi.stubGlobal("window", {
      get location(): never {
        throw new Error("no location");
      },
    });
    expectPending(drawDashboard(API));
  });

  test("(c1) a window with a real origin: a root-relative path is still drawn pending, and no address is handed on", () => {
    vi.stubGlobal("window", { location: { origin: "https://app.example" } });
    expectPending(drawDashboard(API));
  });

  test("(c2) a window with a real origin: an absolute URL of another origin is drawn pending too (the server cannot tell)", () => {
    vi.stubGlobal("window", { location: { origin: "https://app.example" } });
    expectPending(drawPortlet(`https://evil.example${API}`));
  });
});
