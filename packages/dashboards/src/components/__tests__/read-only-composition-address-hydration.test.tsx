// @vitest-environment jsdom
//
// THE SERVER'S MARKUP HYDRATES WITHOUT A MISMATCH (cinatra#3092, #4118 fold). The
// session road's address is resolved against the page's own origin, which only
// the browser knows. So the server draws the session road as a neutral pending
// placeholder, the client draws that same placeholder while it hydrates the
// server's markup, and only then resolves the road: to the session provider over
// the resolved href, or to the refusal. A server that drew the refusal while the
// client drew the provider is a hydration mismatch.
//
// Also here: on the client, a page with no usable origin (opaque, empty, no
// location, a location read that throws, no window at all) still refuses the
// session road.
//
// The server render runs with the window removed (`typeof window` is
// "undefined", as on a server) and is then hydrated into jsdom with
// `hydrateRoot`. `drizzle-cube/client` is substituted by a RECORDING module of
// the three components the composition mounts.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/read-only-composition-address-hydration.test.tsx

import React, { type ReactNode } from "react";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";

import { API, PAGE_ORIGIN, SAME_ORIGIN_API } from "./read-only-composition-road-fixtures";

const rec = vi.hoisted(() => ({
  cube: [] as Record<string, unknown>[],
  dashboard: 0,
}));

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

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rec.cube.length = 0;
  rec.dashboard = 0;
});

// What this file substituted, it hands back: the package's full run stays
// unaffected by the recording module.
afterAll(() => {
  vi.doUnmock("drizzle-cube/client");
  vi.resetModules();
});

const CONFIG = {
  portlets: [{ id: "p1", title: "Portlet one", x: 0, y: 0, w: 6, h: 4, chartType: "table", query: "{}" }],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

// Typed loosely so this file reads the same against any version of the props.
const Dashboard = ReadOnlyComposedDashboard as unknown as (p: Record<string, unknown>) => React.JSX.Element;
const Portlet = ReadOnlySinglePortlet as unknown as (p: Record<string, unknown>) => React.JSX.Element;

const REFUSAL = '[role="alert"][data-cinatra-read-only-composition-refused="data-road"]';
const PENDING_MARK = 'data-cinatra-read-only-composition-pending="data-road"';
const REFUSAL_MARK = 'data-cinatra-read-only-composition-refused="data-road"';

/** The server's markup: rendered with no window, as a server renders it. */
function renderOnServer(element: React.JSX.Element): string {
  vi.stubGlobal("window", undefined);
  try {
    expect(typeof window).toBe("undefined");
    return renderToString(element);
  } finally {
    vi.unstubAllGlobals();
  }
}

type Hydrated = { recoverable: unknown[]; hydrationErrors: string[] };

/** Hydrates `markup` with `element` in jsdom and collects every mismatch report:
 *  the recoverable errors React hands `onRecoverableError`, and any console
 *  error that names hydration. */
function hydrate(markup: string, element: React.JSX.Element): Hydrated {
  expect(typeof window).not.toBe("undefined");
  const recoverable: unknown[] = [];
  const consoleErrors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  });
  const container = document.createElement("div");
  container.innerHTML = markup;
  document.body.appendChild(container);
  act(() => {
    roots.push(hydrateRoot(container, element, { onRecoverableError: (error) => recoverable.push(error) }));
  });
  return { recoverable, hydrationErrors: consoleErrors.filter((line) => /hydrat/i.test(line)) };
}

function expectNoMismatch(hydrated: Hydrated) {
  expect(hydrated.recoverable).toEqual([]);
  expect(hydrated.hydrationErrors).toEqual([]);
}

/** The server drew the placeholder: no provider, no address, no refusal. */
function expectServerPending(markup: string) {
  expect(markup).toContain(PENDING_MARK);
  expect(markup).not.toContain(REFUSAL_MARK);
  expect(markup).not.toContain("cube-provider");
  expect(rec.cube).toEqual([]);
  expect(rec.dashboard).toBe(0);
}

/** After hydration: the session provider over exactly `href`, and no refusal. */
function expectAdmittedOver(href: string) {
  expect(rec.cube.length).toBeGreaterThan(0);
  for (const props of rec.cube) expect(props.apiOptions).toEqual({ apiUrl: href, credentials: "include" });
  expect(rec.dashboard).toBeGreaterThan(0);
  expect(document.querySelectorAll(REFUSAL)).toHaveLength(0);
  expect(document.querySelectorAll(`[${PENDING_MARK}]`)).toHaveLength(0);
}

function expectRefusedOnClient() {
  expect(rec.cube).toEqual([]);
  expect(rec.dashboard).toBe(0);
  expect(document.querySelectorAll(REFUSAL)).toHaveLength(1);
  expect(document.querySelectorAll(`[${PENDING_MARK}]`)).toHaveLength(0);
}

describe("the server's markup of the session road hydrates without a mismatch, then resolves (#4118)", () => {
  test("(h1) a root-relative path: the server draws the placeholder, the client hydrates it and mounts the provider over the resolved href", () => {
    const element = <Dashboard config={CONFIG} dataRoad={{ road: "session", apiUrl: API }} />;
    const markup = renderOnServer(element);
    expectServerPending(markup);
    expectNoMismatch(hydrate(markup, element));
    expectAdmittedOver(SAME_ORIGIN_API);
  });

  test("(h2) the single portlet: a root-relative path hydrates without a mismatch and mounts the provider over the resolved href", () => {
    const element = <Portlet config={CONFIG} portletId="p1" dataRoad={{ road: "session", apiUrl: API }} />;
    const markup = renderOnServer(element);
    expectServerPending(markup);
    expectNoMismatch(hydrate(markup, element));
    expectAdmittedOver(SAME_ORIGIN_API);
  });

  test("(h3) an absolute URL of the page's own origin hydrates without a mismatch and mounts the provider over it", () => {
    const element = <Dashboard config={CONFIG} dataRoad={{ road: "session", apiUrl: SAME_ORIGIN_API }} />;
    const markup = renderOnServer(element);
    expectServerPending(markup);
    expectNoMismatch(hydrate(markup, element));
    expectAdmittedOver(SAME_ORIGIN_API);
  });

  test("(h4) an absolute URL of another origin: the server draws the placeholder, the client hydrates it and then refuses", () => {
    const element = <Dashboard config={CONFIG} dataRoad={{ road: "session", apiUrl: `https://evil.example${API}` }} />;
    const markup = renderOnServer(element);
    expectServerPending(markup);
    expectNoMismatch(hydrate(markup, element));
    expectRefusedOnClient();
  });

  test("[guard] (h5) the none road is drawn on the server and hydrates without a mismatch, over no address", () => {
    const element = <Dashboard config={CONFIG} dataRoad={{ road: "none" }} />;
    const markup = renderOnServer(element);
    expect(markup).toContain("cube-provider");
    expect(markup).not.toContain(REFUSAL_MARK);
    rec.cube.length = 0;
    expectNoMismatch(hydrate(markup, element));
    expect(rec.cube.length).toBeGreaterThan(0);
    for (const props of rec.cube) expect(props.apiOptions).toEqual({ credentials: "omit" });
  });

  test("[guard] (h6) an unknown road is refused on the server and on the client alike, without a mismatch", () => {
    const element = <Dashboard config={CONFIG} dataRoad={{ road: "Session", apiUrl: API }} />;
    const markup = renderOnServer(element);
    expect(markup).toContain(REFUSAL_MARK);
    expectNoMismatch(hydrate(markup, element));
    expectRefusedOnClient();
  });
});

/**
 * Runs `run` with `window` absent for the composition's client snapshot read
 * alone: inside `readPageOrigin`, `typeof window` is "undefined", as on a client
 * with no window; React and jsdom keep jsdom's own window, which React's own
 * scheduling reads. Returns how many reads it answered with no window.
 */
function withoutWindowForTheOriginRead(run: () => void): number {
  const scope = globalThis as unknown as Record<string, unknown>;
  const own = Object.getOwnPropertyDescriptor(scope, "window");
  if (own === undefined || own.configurable !== true) throw new Error("the window cannot be hidden here");
  const real = scope.window;
  let hidden = 0;
  Object.defineProperty(scope, "window", {
    configurable: true,
    enumerable: own.enumerable,
    get() {
      if ((new Error().stack ?? "").includes("readPageOrigin")) {
        hidden += 1;
        return undefined;
      }
      return real;
    },
  });
  try {
    run();
  } finally {
    Object.defineProperty(scope, "window", own);
  }
  return hidden;
}

describe("on the client, a page with no usable origin refuses the session road (#4118)", () => {
  // Each stand-in replaces only what `window` names; the document React renders
  // into is jsdom's own.
  const NO_ORIGIN: ReadonlyArray<readonly [string, () => unknown]> = [
    ["an opaque \"null\" origin", () => ({ location: { origin: "null" } })],
    ["an empty origin", () => ({ location: { origin: "" } })],
    ["a window with no location", () => ({})],
    [
      "a window whose location read throws",
      () => ({
        get location(): never {
          throw new Error("no location");
        },
      }),
    ],
  ];

  test.each(NO_ORIGIN)("(a1) %s: a root-relative path is refused and reaches no provider", (_name, stand) => {
    vi.stubGlobal("window", stand());
    render(<Dashboard config={CONFIG} dataRoad={{ road: "session", apiUrl: API }} />);
    expectRefusedOnClient();
  });

  test("(a3) a client render with no window at all: a root-relative path is refused and reaches no provider", () => {
    const hidden = withoutWindowForTheOriginRead(() => {
      render(<Dashboard config={CONFIG} dataRoad={{ road: "session", apiUrl: API }} />);
    });
    // The client snapshot read saw no window, on every read React made of it.
    expect(hidden).toBeGreaterThan(0);
    expect(typeof window).not.toBe("undefined");
    expectRefusedOnClient();
  });

  test("[guard] (a2) the stand-ins are read: with jsdom's own window the same road is admitted on the page's origin", () => {
    expect(window.location.origin).toBe(PAGE_ORIGIN);
    render(<Portlet config={CONFIG} portletId="p1" dataRoad={{ road: "session", apiUrl: SAME_ORIGIN_API }} />);
    expectAdmittedOver(SAME_ORIGIN_API);
  });
});
