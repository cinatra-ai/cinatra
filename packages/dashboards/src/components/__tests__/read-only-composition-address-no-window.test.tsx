// THE SESSION ROAD WITHOUT A PAGE ORIGIN IS REFUSED (cinatra#3092, #4118). The
// composition resolves the session road's address once, against
// `window.location.origin`. Where there is no window (a server render), or the
// page's origin is missing, empty or opaque ("null"), there is no origin to
// resolve against and the road is refused: no provider mounts, so no address is
// handed on. A stand-in window with a real origin is the control that the same
// render does admit a road and hands the resolved href on.
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

// Typed loosely so this file reads the same against any version of the props.
const Dashboard = ReadOnlyComposedDashboard as unknown as (p: Record<string, unknown>) => React.JSX.Element;
const Portlet = ReadOnlySinglePortlet as unknown as (p: Record<string, unknown>) => React.JSX.Element;

function drawDashboard(apiUrl: string): string {
  return renderToStaticMarkup(<Dashboard config={CONFIG} dataRoad={{ road: "session", apiUrl }} />);
}

function drawPortlet(apiUrl: string): string {
  return renderToStaticMarkup(<Portlet config={CONFIG} portletId="p1" dataRoad={{ road: "session", apiUrl }} />);
}

function expectRefused(markup: string) {
  expect(rec.cube).toEqual([]);
  expect(rec.dashboard).toBe(0);
  expect(markup).toContain(REFUSAL);
}

describe("with no window there is no origin to resolve against: the session road is refused (#4118)", () => {
  test("[guard] (w0) this file runs where there is no window", () => {
    expect(typeof window).toBe("undefined");
  });

  test("(w1) a root-relative path is refused and reaches no provider", () => {
    expectRefused(drawDashboard(API));
  });

  test("(w2) the single portlet: a root-relative path is refused and reaches no provider", () => {
    expectRefused(drawPortlet(API));
  });

  test("[guard] (w3) an absolute URL is refused and reaches no provider", () => {
    expectRefused(drawDashboard(`http://localhost:3000${API}`));
  });

  test("[guard] (w4) the none road is still drawn, over no address", () => {
    const markup = renderToStaticMarkup(<Dashboard config={CONFIG} dataRoad={{ road: "none" }} />);
    expect(rec.cube).toHaveLength(1);
    expect(rec.cube[0]?.apiOptions).toEqual({ credentials: "omit" });
    expect(markup).not.toContain(REFUSAL);
  });
});

describe("a page whose origin is opaque, empty or missing has no origin to resolve against (#4118)", () => {
  test("(o1) an opaque \"null\" origin: a root-relative path is refused and reaches no provider", () => {
    vi.stubGlobal("window", { location: { origin: "null" } });
    expectRefused(drawDashboard(API));
  });

  test("[guard] (o2) an opaque \"null\" origin: an absolute URL is refused and reaches no provider", () => {
    vi.stubGlobal("window", { location: { origin: "null" } });
    expectRefused(drawPortlet(`http://localhost:3000${API}`));
  });

  test("(o3) an empty origin: a root-relative path is refused and reaches no provider", () => {
    vi.stubGlobal("window", { location: { origin: "" } });
    expectRefused(drawDashboard(API));
  });

  test("(o4) a window with no location: a root-relative path is refused and reaches no provider", () => {
    vi.stubGlobal("window", {});
    expectRefused(drawDashboard(API));
  });

  test("(o5) a window whose location read throws: a root-relative path is refused and reaches no provider", () => {
    vi.stubGlobal("window", {
      get location(): never {
        throw new Error("no location");
      },
    });
    expectRefused(drawDashboard(API));
  });
});

describe("control: with a page origin the same render admits the road and hands the resolved href on (#4118)", () => {
  test("(c1) a root-relative path reaches the provider as the absolute href of the page's origin", () => {
    vi.stubGlobal("window", { location: { origin: "https://app.example" } });
    const markup = drawDashboard(API);
    expect(rec.cube).toHaveLength(1);
    expect(rec.cube[0]?.apiOptions).toEqual({ apiUrl: `https://app.example${API}`, credentials: "include" });
    expect(rec.dashboard).toBe(1);
    expect(markup).not.toContain(REFUSAL);
  });

  test("[guard] (c2) an absolute URL of another origin is refused", () => {
    vi.stubGlobal("window", { location: { origin: "https://app.example" } });
    expectRefused(drawPortlet(`https://evil.example${API}`));
  });
});
